import { describe, expect, it } from 'vitest';

import { buildBalanceForecastRequest } from './useBalanceForecast';

describe('buildBalanceForecastRequest', () => {
  it('keeps schedule forecast filters and account selection', () => {
    expect(
      buildBalanceForecastRequest({
        budgetId: 'default',
        accountIds: ['acct'],
        conditions: [{ field: 'account', op: 'is', value: 'acct' }],
        conditionsOp: 'and',
        startDate: '2024-03-01',
        endDate: '2024-03-31',
        includeAccountlessSchedules: true,
        source: 'schedules',
      }),
    ).toEqual({
      budgetId: 'default',
      accountIds: ['acct'],
      conditions: [{ field: 'account', op: 'is', value: 'acct' }],
      conditionsOp: 'and',
      startDate: '2024-03-01',
      endDate: '2024-03-31',
      includeAccountlessSchedules: true,
      source: 'schedules',
    });
  });

  it('omits tracking budget filters and account selection when undefined', () => {
    expect(
      buildBalanceForecastRequest({
        budgetId: 'default',
        startDate: '2024-03-01',
        endDate: '2024-03-31',
        source: 'tracking-budget',
      }),
    ).toEqual({
      budgetId: 'default',
      startDate: '2024-03-01',
      endDate: '2024-03-31',
      source: 'tracking-budget',
    });
  });

  it('defaults to schedules when source is omitted', () => {
    expect(
      buildBalanceForecastRequest({
        budgetId: 'default',
        startDate: '2024-03-01',
        endDate: '2024-03-31',
      }),
    ).toEqual({
      budgetId: 'default',
      startDate: '2024-03-01',
      endDate: '2024-03-31',
      source: 'schedules',
    });
  });
});
