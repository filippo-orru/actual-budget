import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { setSyncingMode } from '#server/sync';
import {
  getProbableCategory,
  insertRule,
  loadRules,
  runRules,
} from '#server/transactions/transaction-rules';
import { clearUndo, undo } from '#server/undo';
import { currentDay } from '#shared/months';

import { batchUpdateTransactions } from './index';

beforeEach(async () => {
  await global.emptyDatabase()();
  db.runQuery("UPDATE budgets SET currency_code = 'USD' WHERE id = 'default'");
  clearUndo();
});

afterEach(() => {
  setSyncingMode('disabled');
  clearUndo();
});

afterEach(() => {
  clearUndo();
});

describe('batchUpdateTransactions', () => {
  it('returns the added, updated and deleted transactions separately', async () => {
    await db.insertAccount({
      budget_id: 'default',
      id: 'one',
      name: 'one',
    });
    await db.insertTransaction({
      id: 'to-update',
      account: 'one',
      amount: 100,
      date: '2024-01-01',
    });
    await db.insertTransaction({
      id: 'to-delete',
      account: 'one',
      amount: 200,
      date: '2024-01-02',
    });

    const result = await batchUpdateTransactions({
      added: [{ id: 'added', account: 'one', amount: 300, date: '2024-01-03' }],
      updated: [{ id: 'to-update', amount: 150 }],
      deleted: [{ id: 'to-delete' }],
      // With transfers enabled the returned updates only carry
      // transfer changes; this test is about the partitioning
      runTransfers: false,
    });

    expect(result.added.map(transaction => transaction.id)).toEqual(['added']);
    expect(result.updated.map(transaction => transaction?.id)).toEqual([
      'to-update',
    ]);
    expect(result.deleted.map(transaction => transaction.id)).toEqual([
      'to-delete',
    ]);
    expect(result.errors).toEqual([]);

    const remaining = await db.all<{ id: string; amount: number }>(
      'SELECT id, amount FROM v_transactions_internal WHERE tombstone = 0 ORDER BY id',
    );
    expect(remaining).toEqual([
      { id: 'added', amount: 300 },
      { id: 'to-update', amount: 150 },
    ]);
  });

  it('rejects USD-to-USD and USD-to-EUR transfers before any batch side effects', async () => {
    setSyncingMode('offline');
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const secondUsd = await runHandler(handlers['budget-spaces/create'], {
      name: 'Second USD',
      currencyCode: 'USD',
    });
    const euro = await runHandler(handlers['budget-spaces/create'], {
      name: 'Euro',
      currencyCode: 'EUR',
    });
    await runHandler(handlers['budget-spaces/update'], {
      id: 'default',
      currencyCode: 'USD',
    });

    const accountA = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const accountB = await runHandler(handlers['account-create'], {
      budgetId: secondUsd.id,
      name: 'Checking',
    });
    const accountEuro = await runHandler(handlers['account-create'], {
      budgetId: euro.id,
      name: 'Checking',
    });
    const transferPayeeFor = async (accountId: string) =>
      db.first<{ id: string }>(
        'SELECT id FROM payees WHERE transfer_acct = ?',
        [accountId],
      );
    const usdPayee = await transferPayeeFor(accountB);
    const eurPayee = await transferPayeeFor(accountEuro);
    if (!usdPayee || !eurPayee) throw new Error('Missing transfer payee');

    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.currency', 'false'), ('flags.multiCurrency', 'false')",
    );
    const messagesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    expect(messagesBefore?.count).toBeGreaterThan(0);
    const rulesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM rules WHERE tombstone = 0',
    );
    clearUndo();

    for (const [id, transferPayee, runTransfers] of [
      ['same-currency-invalid', usdPayee.id, false],
      ['foreign-currency-invalid', eurPayee.id, false],
    ] as const) {
      await expect(
        runHandler(handlers['transactions-batch-update'], {
          added: [
            {
              id: `${id}-valid`,
              account: accountB,
              amount: 100,
              date: '2024-01-01',
            },
            {
              id,
              account: accountA,
              payee: transferPayee,
              amount: -100,
              date: '2024-01-01',
            },
          ],
          learnCategories: true,
          runTransfers,
        }),
      ).rejects.toThrow('Transfers cannot cross budget boundaries');
    }

    expect(await db.all('SELECT id FROM transactions')).toEqual([]);
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBefore);
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM rules WHERE tombstone = 0',
      ),
    ).toEqual(rulesBefore);
    await undo();
    expect(await db.all('SELECT id FROM transactions')).toEqual([]);

    await db.insertTransaction({
      id: 'existing-transfer-source',
      account: accountA,
      amount: -25,
      date: '2017-01-01',
    });
    const messagesBeforeUpdate = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    expect(messagesBeforeUpdate?.count).toBeGreaterThan(0);
    await expect(
      runHandler(handlers['transactions-batch-update'], {
        updated: [{ id: 'existing-transfer-source', payee: usdPayee.id }],
        runTransfers: false,
      }),
    ).rejects.toThrow('Transfers cannot cross budget boundaries');
    expect(
      await db.first<{ payee: string | null }>(
        'SELECT payee FROM v_transactions WHERE id = ?',
        ['existing-transfer-source'],
      ),
    ).toEqual({ payee: null });
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBeforeUpdate);
  });

  it('learns shared-payee categories separately for each budget', async () => {
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const second = await runHandler(handlers['budget-spaces/create'], {
      name: 'Second',
      currencyCode: 'USD',
    });
    const groupA = await db.insertCategoryGroup({
      budget_id: 'default',
      name: 'Food',
    });
    const groupB = await db.insertCategoryGroup({
      budget_id: second.id,
      name: 'Food',
    });
    const categoryA = await db.insertCategory({
      budget_id: 'default',
      name: 'A groceries',
      cat_group: groupA,
    });
    const categoryB = await db.insertCategory({
      budget_id: second.id,
      name: 'B groceries',
      cat_group: groupB,
    });
    const accountA = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const accountB = await runHandler(handlers['account-create'], {
      budgetId: second.id,
      name: 'Checking',
    });
    const payee = await db.insertPayee({
      name: 'Shared merchant',
      learn_categories: 1,
    });
    const date = currentDay();
    const added = [
      ...[1, 2, 3].map(index => ({
        id: `a-${index}`,
        account: accountA,
        payee,
        category: categoryA,
        amount: -100,
        date,
      })),
      ...[1, 2, 3].map(index => ({
        id: `b-${index}`,
        account: accountB,
        payee,
        category: categoryB,
        amount: -100,
        date,
      })),
    ];

    await batchUpdateTransactions({
      added,
      learnCategories: true,
      runTransfers: false,
    });

    expect(
      await db.first('SELECT id, learn_categories FROM payees WHERE id = ?', [
        payee,
      ]),
    ).toEqual({ id: payee, learn_categories: 1 });
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM v_transactions WHERE payee = ?',
        [payee],
      ),
    ).toEqual({ count: 6 });
    const learningRows = await db.all(
      `SELECT t.id, t.date, t.category, t.payee, a.budget_id, a.closed, p.learn_categories
       FROM v_transactions t
       JOIN accounts a ON a.id = t.account
       JOIN payees p ON p.id = t.payee
       WHERE t.is_parent = 0 AND a.closed = 0 AND p.learn_categories = 1`,
    );
    expect(learningRows).toHaveLength(6);
    expect(getProbableCategory(await db.getTransactions(accountA))).toBe(
      categoryA,
    );
    const learnedRules = await db.all<{
      budget_id: string;
      actions: string;
    }>('SELECT budget_id, actions FROM rules WHERE tombstone = 0');
    expect(learnedRules).toHaveLength(2);
    expect(
      learnedRules.map(rule => ({
        budget_id: rule.budget_id,
        category: JSON.parse(rule.actions)[0].value,
      })),
    ).toEqual(
      expect.arrayContaining([
        { budget_id: 'default', category: categoryA },
        { budget_id: second.id, category: categoryB },
      ]),
    );
  });

  it('allows same-budget on-budget to off-budget transfers with flags disabled', async () => {
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.currency', 'false'), ('flags.multiCurrency', 'false')",
    );
    const onBudget = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const offBudget = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Investment',
      offBudget: true,
    });
    const transferPayee = await db.first<{ id: string }>(
      'SELECT id FROM payees WHERE transfer_acct = ?',
      [offBudget],
    );
    if (!transferPayee) throw new Error('Missing transfer payee');

    await runHandler(handlers['transaction-add'], {
      id: 'same-budget-transfer',
      account: onBudget,
      payee: transferPayee.id,
      amount: -100,
      date: '2017-01-01',
    });

    const transferRows = await db.all<{
      account: string;
      transfer_id: string | null;
    }>(
      'SELECT account, transfer_id FROM v_transactions WHERE id IN (?, COALESCE((SELECT transfer_id FROM v_transactions WHERE id = ?), ?)) ORDER BY account',
      ['same-budget-transfer', 'same-budget-transfer', 'same-budget-transfer'],
    );
    expect(transferRows).toHaveLength(2);
    expect(transferRows.map(row => row.account)).toContain(onBudget);
    expect(transferRows.map(row => row.account)).toContain(offBudget);
  });

  it('rejects split children that use accounts from different budgets atomically', async () => {
    setSyncingMode('offline');
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const second = await runHandler(handlers['budget-spaces/create'], {
      name: 'Second',
      currencyCode: 'USD',
    });
    const accountA = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const accountB = await runHandler(handlers['account-create'], {
      budgetId: second.id,
      name: 'Checking',
    });
    clearUndo();
    const messagesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    expect(messagesBefore?.count).toBeGreaterThan(0);

    await expect(
      runHandler(handlers['transactions-batch-update'], {
        added: [
          {
            id: 'split-parent',
            account: accountA,
            amount: -100,
            date: '2024-01-01',
            is_parent: true,
          },
          {
            id: 'split-child',
            account: accountB,
            amount: -100,
            date: '2024-01-01',
            is_child: true,
            parent_id: 'split-parent',
          },
        ],
        runTransfers: false,
      }),
    ).rejects.toThrow('Split transactions must belong to the same budget');

    expect(await db.all('SELECT id FROM transactions')).toEqual([]);
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBefore);
  });

  it('prevalidates schedules generated by rules before writing transfer sources', async () => {
    setSyncingMode('offline');
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const second = await runHandler(handlers['budget-spaces/create'], {
      name: 'Second',
      currencyCode: 'USD',
    });
    const sourceAccount = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Source',
    });
    const destinationAccount = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Destination',
    });
    const transferPayee = await db.first<{ id: string }>(
      'SELECT id FROM payees WHERE transfer_acct = ?',
      [sourceAccount],
    );
    const foreignRule = await insertRule({
      budget_id: second.id,
      stage: null,
      conditionsOp: 'and',
      conditions: [],
      actions: [],
    });
    await db.insertWithSchema('schedules', {
      id: 'foreign-schedule',
      budget_id: second.id,
      name: 'Foreign schedule',
      rule: foreignRule,
    });
    await insertRule({
      budget_id: 'default',
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'payee', value: transferPayee!.id }],
      actions: [{ op: 'link-schedule', value: 'foreign-schedule' }],
    });
    await loadMappings();
    await loadRules();
    clearUndo();
    const messagesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    expect(messagesBefore?.count).toBeGreaterThan(0);

    await expect(
      runHandler(handlers['transactions-batch-update'], {
        added: [
          {
            id: 'rule-transfer-source',
            account: sourceAccount,
            payee: await db
              .first<{ id: string }>(
                'SELECT id FROM payees WHERE transfer_acct = ?',
                [destinationAccount],
              )
              .then(payee => payee!.id),
            amount: -100,
            date: '2024-01-01',
          },
        ],
      }),
    ).rejects.toThrow('schedules reference belongs to another budget');

    expect(await db.all('SELECT id FROM transactions')).toEqual([]);
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBefore);

    await db.insertTransaction({
      id: 'existing-source-for-rule-transfer',
      account: sourceAccount,
      amount: -100,
      date: '2024-01-02',
    });
    const sourceBefore = await db.getTransaction(
      'existing-source-for-rule-transfer',
    );
    const messagesBeforeUpdate = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    await expect(
      runHandler(handlers['transactions-batch-update'], {
        updated: [
          {
            id: 'existing-source-for-rule-transfer',
            payee: await db
              .first<{ id: string }>(
                'SELECT id FROM payees WHERE transfer_acct = ?',
                [destinationAccount],
              )
              .then(payee => payee!.id),
          },
        ],
      }),
    ).rejects.toThrow('schedules reference belongs to another budget');
    expect(
      await db.getTransaction('existing-source-for-rule-transfer'),
    ).toEqual(sourceBefore);
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBeforeUpdate);
  });

  it('keeps rule-generated payees and sync messages out of rejected batches', async () => {
    setSyncingMode('offline');
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const second = await runHandler(handlers['budget-spaces/create'], {
      name: 'Second',
      currencyCode: 'USD',
    });
    const accountA = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const accountB = await runHandler(handlers['account-create'], {
      budgetId: second.id,
      name: 'Checking',
    });
    const transferPayee = await db.first<{ id: string }>(
      'SELECT id FROM payees WHERE transfer_acct = ?',
      [accountB],
    );
    if (!transferPayee) throw new Error('Missing transfer payee');

    const pendingPayees = new Map();
    const ruleTransaction = await runRules(
      {
        id: 'rule-payee-source',
        account: accountA,
        payee: 'new',
        payee_name: 'Rule-created merchant',
        amount: -25,
        date: '2024-01-01',
      },
      null,
      pendingPayees,
    );
    expect(pendingPayees.size).toBe(1);
    clearUndo();
    const messagesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );

    await expect(
      batchUpdateTransactions({
        added: [
          {
            id: 'pending-payee-transaction',
            account: accountA,
            payee: ruleTransaction.payee,
            amount: -25,
            date: '2024-01-01',
          },
          {
            id: 'invalid-transfer-transaction',
            account: accountA,
            payee: transferPayee.id,
            amount: -100,
            date: '2024-01-01',
          },
        ],
        pendingPayees: [...pendingPayees.values()],
        runTransfers: false,
      }),
    ).rejects.toThrow('Transfers cannot cross budget boundaries');

    expect(
      await db.first<{ id: string }>('SELECT id FROM payees WHERE name = ?', [
        'Rule-created merchant',
      ]),
    ).toBeNull();
    expect(await db.all('SELECT id FROM transactions')).toEqual([]);
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBefore);
  });

  it('rejects transaction ownership supplied in imported or arbitrary fields', async () => {
    await db.insertAccount({
      id: 'owned-account',
      budget_id: 'default',
      name: 'Checking',
    });

    await expect(
      batchUpdateTransactions({
        added: [
          {
            id: 'transaction-with-owner-field',
            account: 'owned-account',
            amount: -100,
            date: '2017-01-01',
            budget_id: 'default',
          } as never,
        ],
      }),
    ).rejects.toThrow('Transaction ownership is derived from its account');
    expect(await db.all('SELECT id FROM transactions')).toEqual([]);
  });

  it('rejects added ID collisions, duplicate updates, and overlapping writes', async () => {
    setSyncingMode('offline');
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const second = await runHandler(handlers['budget-spaces/create'], {
      name: 'Second',
      currencyCode: 'USD',
    });
    const accountA = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const accountB = await runHandler(handlers['account-create'], {
      budgetId: second.id,
      name: 'Checking',
    });
    await db.insertTransaction({
      id: 'existing-id',
      account: accountA,
      amount: 123,
      date: '2017-01-01',
    });
    clearUndo();
    const messagesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    expect(messagesBefore?.count).toBeGreaterThan(0);

    await expect(
      batchUpdateTransactions({
        added: [
          {
            id: 'existing-id',
            account: accountB,
            amount: 999,
            date: '2017-01-02',
          },
        ],
      }),
    ).rejects.toThrow('Transaction ID already exists: existing-id');
    await expect(
      batchUpdateTransactions({
        updated: [
          { id: 'existing-id', notes: 'first' },
          { id: 'existing-id', account: accountB, category: null } as never,
        ],
      }),
    ).rejects.toThrow('Transaction batch contains duplicate updated IDs');
    await expect(
      batchUpdateTransactions({
        added: [
          {
            id: 'overlapping-id',
            account: accountA,
            amount: 100,
            date: '2017-01-02',
          },
        ],
        updated: [{ id: 'overlapping-id', notes: 'conflicting update' }],
      }),
    ).rejects.toThrow('Transaction ID cannot be both added and updated');

    expect(
      await db.first<{ account: string; amount: number }>(
        'SELECT account, amount FROM v_transactions WHERE id = ?',
        ['existing-id'],
      ),
    ).toEqual({ account: accountA, amount: 123 });
    expect(
      await db.first('SELECT id FROM transactions WHERE id = ?', [
        'overlapping-id',
      ]),
    ).toBeNull();
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBefore);
  });

  it('rejects a foreign category reference before writing a transaction', async () => {
    setSyncingMode('offline');
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const second = await runHandler(handlers['budget-spaces/create'], {
      name: 'Second',
      currencyCode: 'USD',
    });
    const group = await db.insertCategoryGroup({
      budget_id: second.id,
      name: 'Food',
    });
    const foreignCategory = await db.insertCategory({
      budget_id: second.id,
      name: 'Groceries',
      cat_group: group,
    });
    const account = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    clearUndo();
    const messagesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    expect(messagesBefore?.count).toBeGreaterThan(0);

    await expect(
      runHandler(handlers['transactions-batch-update'], {
        added: [
          {
            id: 'foreign-category-transaction',
            account,
            category: foreignCategory,
            amount: -100,
            date: '2017-01-01',
          },
        ],
      }),
    ).rejects.toThrow('categories reference belongs to another budget');

    expect(await db.all('SELECT id FROM transactions')).toEqual([]);
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBefore);
  });

  it('rejects moving an existing transaction to another budget without edits', async () => {
    setSyncingMode('offline');
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const secondUsd = await runHandler(handlers['budget-spaces/create'], {
      name: 'Second USD',
      currencyCode: 'USD',
    });
    const accountA = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const accountB = await runHandler(handlers['account-create'], {
      budgetId: secondUsd.id,
      name: 'Checking',
    });
    await db.insertTransaction({
      id: 'move-between-budgets',
      account: accountA,
      amount: 123,
      date: '2024-01-01',
      category: null,
    });
    clearUndo();
    const messagesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    expect(messagesBefore?.count).toBeGreaterThan(0);

    await expect(
      runHandler(handlers['transactions-batch-update'], {
        updated: [
          {
            id: 'move-between-budgets',
            account: accountB,
            amount: 456,
            category: null,
          },
        ] as never,
        runTransfers: false,
      }),
    ).rejects.toThrow('Transactions cannot move between budgets');

    expect(
      await db.first<{ account: string; amount: number }>(
        'SELECT acct AS account, amount FROM transactions WHERE id = ?',
        ['move-between-budgets'],
      ),
    ).toEqual({ account: accountA, amount: 123 });
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBefore);
  });

  it('clears nullable category values explicitly and permits same-budget account moves', async () => {
    await db.insertCategoryGroup({
      budget_id: 'default',
      id: 'group',
      name: 'Group',
    });
    await db.insertCategory({
      id: 'category-to-clear',
      name: 'Category',
      cat_group: 'group',
    });
    await db.insertAccount({
      budget_id: 'default',
      id: 'one',
      name: 'one',
    });
    await db.insertAccount({
      budget_id: 'default',
      id: 'two',
      name: 'two',
    });
    await db.insertTransaction({
      id: 'same-budget-move',
      account: 'one',
      amount: 100,
      date: '2024-01-01',
      category: 'category-to-clear',
    });

    await batchUpdateTransactions({
      updated: [
        {
          id: 'same-budget-move',
          account: 'two',
          category: null,
        } as never,
      ],
      runTransfers: false,
    });

    expect(
      await db.first<{ account: string; category: string | null }>(
        'SELECT acct AS account, category FROM transactions WHERE id = ?',
        ['same-budget-move'],
      ),
    ).toEqual({ account: 'two', category: null });
  });

  it('does not add any transactions when only editing a field', async () => {
    await db.insertAccount({
      budget_id: 'default',
      id: 'one',
      name: 'one',
    });
    await db.insertTransaction({
      id: 't1',
      account: 'one',
      amount: 100,
      date: '2024-01-01',
    });

    const result = await batchUpdateTransactions({
      updated: [{ id: 't1', notes: 'hello' }],
      runTransfers: false,
    });

    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.updated.map(transaction => transaction?.id)).toEqual(['t1']);
    const updated = await db.first<{ notes: string }>(
      'SELECT notes FROM transactions WHERE id = ?',
      ['t1'],
    );
    expect(updated?.notes).toBe('hello');
  });
});
