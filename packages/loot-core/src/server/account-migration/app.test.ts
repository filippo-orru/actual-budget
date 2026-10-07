import { vi } from 'vitest';

import { makeBackup } from '#server/budgetfiles/backups';
import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import * as prefs from '#server/prefs';
import { setSyncingMode } from '#server/sync';

vi.mock('#server/budgetfiles/backups', async () => {
  const actual = await vi.importActual('#server/budgetfiles/backups');
  return { ...(actual as Record<string, unknown>), makeBackup: vi.fn() };
});

beforeEach(async () => {
  setSyncingMode('offline');
  await global.emptyDatabase()();
  await prefs.loadPrefs();
  db.runQuery("UPDATE budgets SET currency_code = 'USD' WHERE id = 'default'");
  db.runQuery(
    "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
  );
  vi.mocked(makeBackup).mockReset();
});

afterEach(() => {
  setSyncingMode('disabled');
});

describe('account migration', () => {
  it('copies local transactions into a new account and closes the emptied source', async () => {
    const sourceId = await db.insertAccount({
      id: 'source-account',
      budget_id: 'default',
      name: 'Checking',
    });
    await db.insertTransaction({
      id: 'source-transaction',
      account: sourceId,
      amount: -1234,
      date: '2024-01-15',
      payee: null,
      cleared: true,
      reconciled: true,
    });

    const prepared = await runHandler(handlers['account-migration/prepare'], {
      requestId: 'prepare-request',
      sourceAccountId: sourceId,
      destination: {
        type: 'new',
        name: 'Travel',
        currencyCode: 'USD',
      },
      inputCurrency: 'USD',
      accountName: 'Checking',
      offBudget: false,
    });
    expect(prepared.review.canCommit).toBe(true);

    const result = await runHandler(handlers['account-migration/commit'], {
      token: prepared.token,
    });
    await expect(
      runHandler(handlers['account-migration/commit'], {
        token: prepared.token,
      }),
    ).resolves.toMatchObject({
      accountId: result.accountId,
      budgetId: result.budgetId,
      alreadyCommitted: true,
    });
    const destination = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ?',
      [result.accountId],
    );
    expect(destination?.budget_id).toBe(result.budgetId);
    expect(destination?.name).toBe('Checking');
    const copiedRows = await db.getTransactions(result.accountId);
    expect(copiedRows).toHaveLength(1);
    expect(copiedRows[0]).toMatchObject({
      account: result.accountId,
      amount: -1234,
      date: '2024-01-15',
      cleared: true,
      reconciled: false,
    });
    expect(
      await db.first<db.DbAccount>('SELECT * FROM accounts WHERE id = ?', [
        sourceId,
      ]),
    ).toMatchObject({ closed: 1, tombstone: 0 });
    expect(
      await db.first<{ tombstone: number }>(
        'SELECT tombstone FROM transactions WHERE id = ?',
        ['source-transaction'],
      ),
    ).toEqual({ tombstone: 1 });
  });

  it('commits without attempting to create an automatic backup', async () => {
    const sourceId = await db.insertAccount({
      id: 'backup-failure-source',
      budget_id: 'default',
      name: 'Checking',
    });
    await db.insertTransaction({
      id: 'backup-failure-transaction',
      account: sourceId,
      amount: 2500,
      date: '2024-01-15',
    });
    const prepared = await runHandler(handlers['account-migration/prepare'], {
      requestId: 'backup-failure-prepare',
      sourceAccountId: sourceId,
      destination: { type: 'new', name: 'Moved', currencyCode: 'USD' },
      inputCurrency: 'USD',
      accountName: 'Checking',
      offBudget: false,
    });
    vi.mocked(makeBackup).mockRejectedValueOnce(
      new Error('backup unavailable'),
    );

    const result = await runHandler(handlers['account-migration/commit'], {
      token: prepared.token,
    });
    expect(makeBackup).not.toHaveBeenCalled();
    expect(await db.getTransactions(result.accountId)).toHaveLength(1);
    expect(
      await db.first<{ tombstone: number }>(
        'SELECT tombstone FROM transactions WHERE id = ?',
        ['backup-failure-transaction'],
      ),
    ).toEqual({ tombstone: 1 });
    expect(
      await db.first<db.DbAccount>('SELECT * FROM accounts WHERE id = ?', [
        sourceId,
      ]),
    ).toMatchObject({ closed: 1, tombstone: 0 });
    expect(
      await db.first<{ count: number }>(
        "SELECT COUNT(*) AS count FROM budgets WHERE name = 'Moved'",
      ),
    ).toEqual({ count: 1 });
  });

  it('copies missing categories into the destination with fresh ownership and mappings', async () => {
    const destination = await runHandler(handlers['budget-spaces/create'], {
      name: 'Category destination',
      currencyCode: 'USD',
    });
    await db.insertWithSchema('category_groups', {
      id: 'source-food-group',
      budget_id: 'default',
      name: 'Living',
      is_income: false,
      sort_order: 1000,
    });
    await db.insertWithSchema('categories', {
      id: 'source-food-category',
      budget_id: 'default',
      name: 'Food',
      group: 'source-food-group',
      is_income: false,
      hidden: false,
      sort_order: 1000,
    });
    await db.insert('category_mapping', {
      id: 'source-food-category',
      transferId: 'source-food-category',
    });
    const sourceId = await db.insertAccount({
      id: 'category-source-account',
      budget_id: 'default',
      name: 'Checking',
    });
    await db.insertTransaction({
      id: 'category-source-transaction',
      account: sourceId,
      amount: -4500,
      date: '2024-01-15',
      category: 'source-food-category',
    });

    const prepared = await runHandler(handlers['account-migration/prepare'], {
      requestId: 'category-prepare',
      sourceAccountId: sourceId,
      destination: { type: 'existing', budgetId: destination.id },
      inputCurrency: 'USD',
      accountName: 'Checking',
      offBudget: false,
    });
    expect(prepared.review.canCommit).toBe(true);
    expect(prepared.review.categoryCreations).toEqual([
      expect.objectContaining({ name: 'Food', groupName: 'Living' }),
    ]);
    expect(
      await db.first<db.DbCategory>(
        'SELECT * FROM categories WHERE budget_id = ? AND name = ?',
        [destination.id, 'Food'],
      ),
    ).toBeNull();
    await runHandler(handlers['account-migration/commit'], {
      token: prepared.token,
    });
    const copied = await db.getTransactions(
      prepared.review.destinationAccountId,
    );
    const copiedCategoryId = copied[0].category;

    expect(copiedCategoryId).not.toBe('source-food-category');
    expect(
      await db.first<db.DbCategory>('SELECT * FROM categories WHERE id = ?', [
        copiedCategoryId,
      ]),
    ).toMatchObject({ budget_id: destination.id, name: 'Food' });
    expect(
      await db.first<db.DbCategoryMapping>(
        'SELECT * FROM category_mapping WHERE id = ?',
        [copiedCategoryId],
      ),
    ).toEqual({ id: copiedCategoryId, transferId: copiedCategoryId });
  });

  it.each(['new', 'existing'] as const)(
    'matches the starting balance category in a %s destination space',
    async destinationType => {
      const destination = await runHandler(handlers['budget-spaces/create'], {
        name: 'Starting balance destination',
        currencyCode: 'USD',
      });
      await db.insertWithSchema('category_groups', {
        id: 'source-income-group',
        budget_id: 'default',
        name: 'Income',
        is_income: true,
        sort_order: 0,
      });
      await db.insertWithSchema('categories', {
        id: 'source-starting-balance',
        budget_id: 'default',
        name: 'Starting Balances',
        group: 'source-income-group',
        is_income: true,
        hidden: false,
        sort_order: 0,
      });
      await db.insert('category_mapping', {
        id: 'source-starting-balance',
        transferId: 'source-starting-balance',
      });
      const sourceId = await db.insertAccount({
        id: 'starting-balance-source',
        budget_id: 'default',
        name: 'Checking',
      });
      await db.insertTransaction({
        id: 'starting-balance-transaction',
        account: sourceId,
        amount: 5000,
        date: '2024-01-15',
        category: 'source-starting-balance',
      });
      const prepared = await runHandler(handlers['account-migration/prepare'], {
        requestId: 'starting-balance-prepare',
        sourceAccountId: sourceId,
        destination:
          destinationType === 'new'
            ? { type: 'new', name: 'New destination', currencyCode: 'USD' }
            : { type: 'existing', budgetId: destination.id },
        inputCurrency: 'USD',
        accountName: 'Checking',
        offBudget: false,
      });
      expect(prepared.review.canCommit).toBe(true);
      expect(prepared.review.categoryCreations).toHaveLength(0);
      const result = await runHandler(handlers['account-migration/commit'], {
        token: prepared.token,
      });
      const destinationCategory = await db.first<db.DbCategory>(
        'SELECT * FROM categories WHERE budget_id = ? AND name = ?',
        [result.budgetId, 'Starting Balances'],
      );
      expect(await db.getTransactions(result.accountId)).toEqual([
        expect.objectContaining({ category: destinationCategory!.id }),
      ]);
    },
  );

  it.each([true, false])(
    'matches duplicate category names automatically (same group: %s)',
    async sameGroup => {
      const destination = await runHandler(handlers['budget-spaces/create'], {
        name: 'Matching destination',
        currencyCode: 'USD',
      });
      for (const [id, budgetId, name] of [
        ['source-group', 'default', 'Living'],
        ['destination-first-group', destination.id, 'Other'],
        [
          'destination-second-group',
          destination.id,
          sameGroup ? 'Living' : 'Other',
        ],
      ]) {
        await db.insertWithSchema('category_groups', {
          id,
          budget_id: budgetId,
          name,
          is_income: false,
          sort_order: 1000,
        });
      }
      for (const [id, budgetId, group, sortOrder] of [
        ['source-food', 'default', 'source-group', 1000],
        [
          'destination-first-food',
          destination.id,
          'destination-first-group',
          1000,
        ],
        [
          'destination-second-food',
          destination.id,
          'destination-second-group',
          2000,
        ],
      ] as const) {
        await db.insertWithSchema('categories', {
          id,
          budget_id: budgetId,
          name: 'Food',
          group,
          is_income: false,
          hidden: false,
          sort_order: sortOrder,
        });
        await db.insert('category_mapping', { id, transferId: id });
      }
      const sourceId = await db.insertAccount({
        id: 'matching-source',
        budget_id: 'default',
        name: 'Checking',
      });
      await db.insertTransaction({
        id: 'matching-transaction',
        account: sourceId,
        amount: -4500,
        date: '2024-01-15',
        category: 'source-food',
      });
      const prepared = await runHandler(handlers['account-migration/prepare'], {
        requestId: 'matching-prepare',
        sourceAccountId: sourceId,
        destination: { type: 'existing', budgetId: destination.id },
        inputCurrency: 'USD',
        accountName: 'Checking',
        offBudget: false,
      });
      expect(prepared.review.canCommit).toBe(true);
      expect(prepared.review.categoryCreations).toHaveLength(0);
      const result = await runHandler(handlers['account-migration/commit'], {
        token: prepared.token,
      });
      expect(await db.getTransactions(result.accountId)).toEqual([
        expect.objectContaining({
          category: sameGroup
            ? 'destination-second-food'
            : 'destination-first-food',
        }),
      ]);
    },
  );

  it('blocks executable account-specific rules in both eligibility and preparation', async () => {
    const accountId = await db.insertAccount({
      id: 'rule-source-account',
      budget_id: 'default',
      name: 'Checking',
    });
    await db.insert('rules', {
      id: 'account-specific-rule',
      budget_id: 'default',
      stage: 'pre',
      conditions: JSON.stringify([
        { field: 'account', op: 'is', value: accountId },
      ]),
      conditions_op: 'and',
      actions: '[]',
      tombstone: 0,
    });

    const eligibility = await runHandler(handlers['account-migration/check'], {
      sourceAccountId: accountId,
    });
    expect(eligibility.blockers).toContainEqual(
      expect.objectContaining({ type: 'rule', id: 'account-specific-rule' }),
    );
    await expect(
      runHandler(handlers['account-migration/prepare'], {
        requestId: 'rule-prepare',
        sourceAccountId: accountId,
        destination: { type: 'new', name: 'Moved', currencyCode: 'USD' },
        inputCurrency: 'USD',
        accountName: 'Checking',
        offBudget: false,
      }),
    ).rejects.toThrow('Resolve account migration blockers');
  });

  it('blocks bank-linked accounts in both eligibility and preparation', async () => {
    const accountId = await db.insertAccount({
      id: 'linked-account',
      budget_id: 'default',
      name: 'Linked',
    });
    await db.update('accounts', { id: accountId, account_id: 'provider-id' });

    const eligibility = await runHandler(handlers['account-migration/check'], {
      sourceAccountId: accountId,
    });
    expect(eligibility.blockers).toContainEqual(
      expect.objectContaining({ type: 'bank-link', id: accountId }),
    );
    await expect(
      runHandler(handlers['account-migration/prepare'], {
        requestId: 'linked-prepare',
        sourceAccountId: accountId,
        destination: { type: 'new', name: 'Moved', currencyCode: 'USD' },
        inputCurrency: 'USD',
        accountName: 'Linked',
        offBudget: false,
      }),
    ).rejects.toThrow('Resolve account migration blockers');
  });

  it('detaches a linked transfer without changing the counterpart transaction', async () => {
    const sourceId = await db.insertAccount({
      id: 'transfer-source-account',
      budget_id: 'default',
      name: 'Checking',
    });
    const stayingId = await db.insertAccount({
      id: 'transfer-staying-account',
      budget_id: 'default',
      name: 'Savings',
    });
    const sourceTransferPayee = await db.first<{ id: string }>(
      'SELECT id FROM payees WHERE transfer_acct = ?',
      [sourceId],
    );
    const stayingTransferPayee = await db.first<{ id: string }>(
      'SELECT id FROM payees WHERE transfer_acct = ?',
      [stayingId],
    );
    await db.insertTransaction({
      id: 'transfer-source-transaction',
      account: sourceId,
      amount: -1000,
      date: '2024-02-01',
      payee: stayingTransferPayee?.id,
      transfer_id: 'transfer-staying-transaction',
      cleared: false,
    });
    await db.insertTransaction({
      id: 'transfer-staying-transaction',
      account: stayingId,
      amount: 1000,
      date: '2024-02-01',
      payee: sourceTransferPayee?.id,
      transfer_id: 'transfer-source-transaction',
      cleared: true,
      reconciled: true,
    });

    const prepared = await runHandler(handlers['account-migration/prepare'], {
      requestId: 'transfer-prepare',
      sourceAccountId: sourceId,
      destination: { type: 'new', name: 'Moved', currencyCode: 'USD' },
      inputCurrency: 'USD',
      accountName: 'Checking',
      offBudget: false,
    });
    await runHandler(handlers['account-migration/commit'], {
      token: prepared.token,
    });

    const counterpart = await db.getTransaction('transfer-staying-transaction');
    expect(counterpart).toMatchObject({
      account: stayingId,
      amount: 1000,
      date: '2024-02-01',
      cleared: true,
      reconciled: true,
      payee: null,
    });
    expect(counterpart?.transfer_id).toBeNull();
    expect(counterpart?.notes).toContain('detached');
    const movedTransactions = await db.getTransactions(
      prepared.review.destinationAccountId,
    );
    expect(movedTransactions[0]).toMatchObject({
      account: prepared.review.destinationAccountId,
      amount: -1000,
      payee: null,
      transfer_id: null,
    });
  });
});
