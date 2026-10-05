import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';

import { app } from './app';

beforeEach(async () => {
  await global.emptyDatabase()();
});

describe('saved filter budget ownership', () => {
  it('rejects foreign account references before writing a filter', async () => {
    await db.insertWithSchema('budgets', {
      id: 'budget-b',
      name: 'Budget B',
      currency_code: 'USD',
      budget_type: 'envelope',
      sort_order: 1,
    });
    await db.insertAccount({
      budget_id: 'budget-b',
      id: 'account-b',
      name: 'Account B',
    });

    await expect(
      app.handlers['filter-create']({
        budgetId: 'default',
        state: {
          name: 'Foreign account filter',
          conditionsOp: 'and',
          conditions: [{ field: 'account', op: 'is', value: 'account-b' }],
        },
        filters: [],
      }),
    ).rejects.toThrow('requested budget');

    expect(
      await db.all<{ id: string }>('SELECT id FROM transaction_filters'),
    ).toEqual([]);
  });
});
