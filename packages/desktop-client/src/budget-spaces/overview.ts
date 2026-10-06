import { getCurrency } from '@actual-app/core/shared/currencies';
import type { BudgetSpaceEntity } from '@actual-app/core/types/models';

export type BudgetBalanceRow = { budgetId: string; balance: number };

export function mapBudgetBalances(
  budgets: BudgetSpaceEntity[],
  rows: BudgetBalanceRow[],
): Record<string, number> {
  const balances = Object.fromEntries(
    budgets.filter(budget => !budget.tombstone).map(budget => [budget.id, 0]),
  );

  for (const row of rows) {
    if (Object.hasOwn(balances, row.budgetId)) {
      balances[row.budgetId] = row.balance;
    }
  }

  return balances;
}

/** Converts integer minor units and rounds once to the target currency's unit. */
export function convertOverviewBalance(
  amount: number,
  rate: number | null | undefined,
  fromCurrency: string,
  toCurrency: string,
): number | null {
  const from = getCurrency(fromCurrency);
  const to = getCurrency(toCurrency);
  if (!fromCurrency || !toCurrency) {
    return null;
  }
  if (amount === 0) {
    return 0;
  }
  if (rate == null || !Number.isFinite(rate)) {
    return null;
  }

  const converted =
    (amount / 10 ** from.decimalPlaces) * rate * 10 ** to.decimalPlaces;
  const rounded = Math.round(Math.abs(converted) * (1 + Number.EPSILON));
  return converted < 0 && rounded !== 0 ? -rounded : rounded;
}
