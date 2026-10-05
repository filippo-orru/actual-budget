import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { loadRules } from '#server/transactions/transaction-rules';

import { app } from './app';

beforeEach(async () => {
  await global.emptyDatabase()();
  await loadRules();
});

describe('rule budget ownership', () => {
  it('rejects a rule action that references another budget category before writing', async () => {
    await db.insertWithSchema('budgets', {
      id: 'budget-b',
      name: 'Budget B',
      currency_code: 'USD',
      budget_type: 'envelope',
      sort_order: 1,
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

    await expect(
      app.handlers['rule-add']({
        budget_id: 'default',
        stage: null,
        conditionsOp: 'and',
        conditions: [],
        actions: [{ op: 'set', field: 'category', value: 'category-b' }],
      }),
    ).rejects.toThrow('requested budget');

    expect(await db.all<{ id: string }>('SELECT id FROM rules')).toEqual([]);

    const rule = await app.handlers['rule-add']({
      budget_id: 'default',
      stage: null,
      conditionsOp: 'and',
      conditions: [],
      actions: [],
    });
    if ('error' in rule) {
      throw new Error('Expected valid rule to be created');
    }
    await expect(
      app.handlers['rule-delete']({ id: rule.id, budgetId: 'budget-b' }),
    ).rejects.toThrow('requested budget');
  });
});
