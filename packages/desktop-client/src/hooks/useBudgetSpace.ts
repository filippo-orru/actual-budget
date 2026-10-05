import { createContext, useContext } from 'react';

import type { BudgetSpaceEntity } from '@actual-app/core/types/models';

export const BudgetSpaceContext = createContext<BudgetSpaceEntity | null>(null);

export function useOptionalBudgetSpace(): BudgetSpaceEntity | null {
  return useContext(BudgetSpaceContext);
}

export function useBudgetSpace(): BudgetSpaceEntity {
  const budgetSpace = useOptionalBudgetSpace();
  if (!budgetSpace) {
    throw new Error('useBudgetSpace must be used within BudgetSpaceProvider.');
  }
  return budgetSpace;
}

export function useBudgetSpaceId(): string {
  return useBudgetSpace().id;
}
