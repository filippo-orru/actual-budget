import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '#platform/server/log';
import * as db from '#server/db';

import { reportInvalidTransactionReferences } from './integrity';

beforeEach(async () => {
  await global.emptyDatabase()();
});

describe('incoming budget integrity diagnostics', () => {
  it('reports cross-budget transaction references without changing synced rows', async () => {
    await db.insertWithSchema('budgets', {
      id: 'budget-b',
      name: 'Budget B',
      currency_code: 'USD',
      budget_type: 'envelope',
      sort_order: 1,
    });
    await db.insertAccount({
      budget_id: 'default',
      id: 'account-a',
      name: 'Account A',
    });
    await db.insertCategoryGroup({
      budget_id: 'budget-b',
      id: 'group-b',
      name: 'Group B',
    });
    await db.insertCategory({
      budget_id: 'budget-b',
      id: 'category-b',
      name: 'Category B',
      cat_group: 'group-b',
    });
    await db.insertTransaction({
      id: 'invalid-transaction',
      date: '2025-01-01',
      account: 'account-a',
      category: 'category-b',
      amount: -100,
    });

    const warning = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined);
    await reportInvalidTransactionReferences(['invalid-transaction']);

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Incoming sync contains cross-budget'),
      { transactionIds: ['invalid-transaction'] },
    );
    expect(
      await db.first<{ category: string }>(
        'SELECT category FROM transactions WHERE id = ?',
        ['invalid-transaction'],
      ),
    ).toEqual({ category: 'category-b' });
    warning.mockRestore();
  });
});
