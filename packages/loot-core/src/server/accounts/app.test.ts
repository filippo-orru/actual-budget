import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { setSyncingMode } from '#server/sync';

beforeEach(async () => {
  setSyncingMode('offline');
  await global.emptyDatabase()();
});

afterEach(() => {
  setSyncingMode('disabled');
});

async function createBudget(name: string, currencyCode: string) {
  return runHandler(handlers['budget-spaces/create'], { name, currencyCode });
}

describe('account ownership', () => {
  it('scopes account lists and converts opening balances using each budget currency', async () => {
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true'), ('flags.currency', 'true')",
    );
    await runHandler(handlers['budget-spaces/update'], {
      id: 'default',
      currencyCode: 'USD',
    });
    const euro = await createBudget('Euro', 'EUR');
    const yen = await createBudget('Yen', 'JPY');

    const euroAccount = await runHandler(handlers['account-create'], {
      budgetId: euro.id,
      name: 'Checking',
      balance: 12.34,
    });
    const yenAccount = await runHandler(handlers['account-create'], {
      budgetId: yen.id,
      name: 'Checking',
      balance: 1000,
    });

    const euroOpening = await db.first<{
      amount: number;
      category: string;
      category_budget_id: string;
    }>(
      `SELECT t.amount, t.category, c.budget_id AS category_budget_id
       FROM transactions t JOIN categories c ON c.id = t.category
       WHERE t.acct = ?`,
      [euroAccount],
    );
    const yenOpening = await db.first<{
      amount: number;
      category: string;
      category_budget_id: string;
    }>(
      `SELECT t.amount, t.category, c.budget_id AS category_budget_id
       FROM transactions t JOIN categories c ON c.id = t.category
       WHERE t.acct = ?`,
      [yenAccount],
    );

    expect(euroOpening).toMatchObject({
      amount: 1234,
      category_budget_id: euro.id,
    });
    expect(yenOpening).toMatchObject({
      amount: 1000,
      category_budget_id: yen.id,
    });

    expect(
      (await runHandler(handlers['accounts-get'], { budgetId: euro.id })).map(
        account => account.id,
      ),
    ).toEqual([euroAccount]);
    expect(
      (await runHandler(handlers['accounts-get'], { budgetId: yen.id })).map(
        account => account.id,
      ),
    ).toEqual([yenAccount]);
    expect(
      (await db.all<{ name: string }>('PRAGMA table_info(accounts)')).map(
        column => column.name,
      ),
    ).not.toContain('currency');
  });

  it('derives balance and deletion targets from the account ID', async () => {
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const second = await createBudget('Second', 'USD');
    const accountA = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const accountB = await runHandler(handlers['account-create'], {
      budgetId: second.id,
      name: 'Checking',
    });
    await db.insertTransaction({
      id: 'second-budget-transaction',
      account: accountB,
      amount: 500,
      date: '2024-01-10',
    });

    await expect(
      runHandler(handlers['account-balance'], {
        id: accountB,
        cutoff: '2024-01-31',
      }),
    ).resolves.toBe(500);
    await runHandler(handlers['account-close'], {
      id: accountB,
      forced: true,
    });

    expect(
      await db.first<{ id: string; tombstone: number }>(
        'SELECT id, tombstone FROM accounts WHERE id = ?',
        [accountA],
      ),
    ).toEqual({ id: accountA, tombstone: 0 });
    expect(
      await db.first<{ id: string; tombstone: number }>(
        'SELECT id, tombstone FROM accounts WHERE id = ?',
        [accountB],
      ),
    ).toEqual({ id: accountB, tombstone: 1 });
    expect(
      await db.first('SELECT id FROM v_transactions WHERE id = ?', [
        'second-budget-transaction',
      ]),
    ).toBeNull();
  });

  it('rejects account ownership and foreign group assignments', async () => {
    db.runQuery(
      "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
    );
    const second = await createBudget('Second', 'USD');
    const accountA = await runHandler(handlers['account-create'], {
      budgetId: 'default',
      name: 'Checking',
    });
    const accountB = await runHandler(handlers['account-create'], {
      budgetId: second.id,
      name: 'Checking',
    });
    const groupB = await runHandler(handlers['account-group-create'], {
      budgetId: second.id,
      name: 'Cash',
    });

    await expect(
      runHandler(handlers['account-update'], {
        id: accountA,
        account_group_id: groupB,
      }),
    ).rejects.toThrow('Account group belongs to another budget');
    await expect(
      db.updateAccount({ id: accountA, budget_id: second.id }),
    ).rejects.toThrow('Account ownership cannot be changed');
    await expect(
      runHandler(handlers['account-move'], {
        id: accountA,
        targetId: accountB,
      }),
    ).rejects.toThrow('Accounts must belong to the same budget');

    expect(
      await runHandler(handlers['accounts-get'], { budgetId: 'default' }),
    ).toHaveLength(1);
    expect(
      await runHandler(handlers['accounts-get'], { budgetId: second.id }),
    ).toHaveLength(1);
  });
});
