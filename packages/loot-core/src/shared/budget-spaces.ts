export const DEFAULT_BUDGET_ID = 'default';

export function budgetMonthId(budgetId: string, month: string): string {
  return budgetId === DEFAULT_BUDGET_ID ? month : `${budgetId}:${month}`;
}
