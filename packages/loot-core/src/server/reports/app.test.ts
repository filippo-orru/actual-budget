import { beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import type { CustomReportEntity } from '#types/models';

import { app } from './app';

beforeEach(async () => {
  await global.emptyDatabase()();
});

function createReport(budgetId: string, name: string): CustomReportEntity {
  return {
    id: '',
    budget_id: budgetId,
    name,
    startDate: '2025-01-01',
    endDate: '2025-01-31',
    isDateStatic: true,
    dateRange: 'static',
    mode: 'report',
    groupBy: 'category',
    interval: 'Monthly',
    balanceType: 'totalTotals',
    showEmpty: false,
    showOffBudget: false,
    showHiddenCategories: false,
    includeCurrentInterval: false,
    showUncategorized: false,
    trimIntervals: false,
    showTrendLines: false,
    graphType: 'BarGraph',
    conditions: [],
    conditionsOp: 'and',
  };
}

describe('custom report budget ownership', () => {
  it('rejects foreign entity references and lists reports by budget', async () => {
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
      app.handlers['report/create']({
        ...createReport('default', 'Foreign account'),
        conditions: [{ field: 'account', op: 'is', value: 'account-b' }],
      }),
    ).rejects.toThrow('requested budget');

    await app.handlers['report/create'](createReport('default', 'Report A'));
    await app.handlers['report/create'](createReport('budget-b', 'Report B'));
    const reportsA = await app.handlers['report/get']({ budgetId: 'default' });
    const reportsB = await app.handlers['report/get']({ budgetId: 'budget-b' });

    expect(reportsA.map(report => report.name)).toEqual(['Report A']);
    expect(reportsB.map(report => report.name)).toEqual(['Report B']);
  });
});
