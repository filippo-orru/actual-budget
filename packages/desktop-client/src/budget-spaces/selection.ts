import type { BudgetSpaceEntity } from '@actual-app/core/types/models';

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
