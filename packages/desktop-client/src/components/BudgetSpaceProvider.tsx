import React from 'react';
import type { ReactNode } from 'react';

import { useQuery } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { selectSoleBudgetSpace } from '#budget-spaces/selection';
import { BudgetSpaceContext } from '#hooks/useBudgetSpace';

import { FeatureErrorFallback } from './FeatureErrorFallback';

type BudgetSpaceProviderProps = {
  fileId: string | undefined;
  children: ReactNode;
};

export function BudgetSpaceProvider({
  fileId,
  children,
}: BudgetSpaceProviderProps) {
  const budgetSpacesQuery = useQuery({
    ...budgetSpaceQueries.list(fileId),
    enabled: !!fileId,
  });

  if (!fileId) {
    return (
      <FeatureErrorFallback
        error={new Error('Cannot select a budget without an open file.')}
        resetErrorBoundary={() => window.location.reload()}
      />
    );
  }
  if (budgetSpacesQuery.isPending) {
    return null;
  }
  if (budgetSpacesQuery.isError) {
    return (
      <FeatureErrorFallback
        error={budgetSpacesQuery.error}
        resetErrorBoundary={() => void budgetSpacesQuery.refetch()}
      />
    );
  }

  let budgetSpace;
  try {
    budgetSpace = selectSoleBudgetSpace(budgetSpacesQuery.data);
  } catch (error) {
    return (
      <FeatureErrorFallback
        error={error instanceof Error ? error : new Error(String(error))}
        resetErrorBoundary={() => void budgetSpacesQuery.refetch()}
      />
    );
  }

  return (
    <BudgetSpaceContext.Provider value={budgetSpace}>
      {children}
    </BudgetSpaceContext.Provider>
  );
}
