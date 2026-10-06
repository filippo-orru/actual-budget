import type { BudgetSpaceEntity } from '@actual-app/core/types/models';

import { convertOverviewBalance, mapBudgetBalances } from './overview';

function budget(id: string, currencyCode = 'EUR'): BudgetSpaceEntity {
  return {
    id,
    name: id,
    currency_code: currencyCode,
    budget_type: 'envelope',
    sort_order: 0,
    tombstone: false,
  };
}

describe('budget overview calculations', () => {
  it('fills budgets without transaction groups with a zero total', () => {
    expect(
      mapBudgetBalances(
        [budget('a'), budget('b'), { ...budget('gone'), tombstone: true }],
        [{ budgetId: 'a', balance: 18500 }],
      ),
    ).toEqual({ a: 18500, b: 0 });
  });

  it('converts summed minor units using source and target decimal places', () => {
    expect(convertOverviewBalance(1000, 1.5, 'USD', 'JPY')).toBe(15);
    expect(convertOverviewBalance(100, 0.5, 'JPY', 'USD')).toBe(5000);
    expect(convertOverviewBalance(-10000, 0.65, 'EUR', 'USD')).toBe(-6500);
  });

  it('rounds symmetrically and does not require a rate for a zero balance', () => {
    expect(convertOverviewBalance(1, 0.5, 'EUR', 'USD')).toBe(1);
    expect(convertOverviewBalance(-1, 0.5, 'EUR', 'USD')).toBe(-1);
    expect(convertOverviewBalance(0, null, 'EUR', 'USD')).toBe(0);
    expect(convertOverviewBalance(100, null, 'EUR', 'USD')).toBeNull();
  });

  it('does not attempt conversion when either currency is None', () => {
    expect(convertOverviewBalance(100, 1, '', 'USD')).toBeNull();
    expect(convertOverviewBalance(100, 1, 'EUR', '')).toBeNull();
  });
});
