import type { BudgetSpaceEntity } from '@actual-app/core/types/models';

const SELECTED_BUDGET_PREFIX = 'selected-budget-space:';

export function getLastSelectedBudgetSpaceId(fileId: string): string | null {
  try {
    return window.localStorage.getItem(`${SELECTED_BUDGET_PREFIX}${fileId}`);
  } catch {
    return null;
  }
}

export function rememberSelectedBudgetSpace(fileId: string, budgetId: string) {
  try {
    window.localStorage.setItem(`${SELECTED_BUDGET_PREFIX}${fileId}`, budgetId);
  } catch {
    // The URL remains authoritative when local storage is unavailable.
  }
}

export function selectBudgetSpace(
  budgetSpaces: BudgetSpaceEntity[],
  preferredId?: string | null,
): BudgetSpaceEntity {
  const activeBudgetSpaces = budgetSpaces.filter(
    budgetSpace => !budgetSpace.tombstone,
  );
  if (activeBudgetSpaces.length === 0) {
    throw new Error('No active budget was found in this file.');
  }

  return (
    activeBudgetSpaces.find(budgetSpace => budgetSpace.id === preferredId) ??
    activeBudgetSpaces.find(budgetSpace => budgetSpace.id === 'default') ??
    activeBudgetSpaces[0]
  );
}
