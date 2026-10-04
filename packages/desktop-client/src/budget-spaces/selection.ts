import type { BudgetSpaceEntity } from '@actual-app/core/types/models';

export function selectSoleBudgetSpace(
  budgetSpaces: BudgetSpaceEntity[],
): BudgetSpaceEntity {
  const activeBudgetSpaces = budgetSpaces.filter(
    budgetSpace => !budgetSpace.tombstone,
  );

  if (activeBudgetSpaces.length === 0) {
    throw new Error('No active budget was found in this file.');
  }
  if (activeBudgetSpaces.length > 1) {
    throw new Error(
      'This file contains multiple budgets, but budget selection is not available yet.',
    );
  }

  return activeBudgetSpaces[0];
}
