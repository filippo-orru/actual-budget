import { useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Trans } from 'react-i18next';
import { Navigate, useLocation } from 'react-router';

import { useQuery } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import {
  getLastSelectedBudgetSpaceId,
  rememberSelectedBudgetSpace,
  selectBudgetSpace,
} from '#budget-spaces/selection';
import { BudgetSpaceContext } from '#hooks/useBudgetSpace';
import {
  budgetRoutes,
  canonicalizeLegacyBudgetPath,
} from '#util/budget-routes';

import { FeatureErrorFallback } from './FeatureErrorFallback';

type BudgetSpaceProviderProps = {
  fileId: string | undefined;
  children: ReactNode;
};

function BudgetNotFound() {
  return (
    <main role="alert" style={{ padding: 24 }}>
      <h1>
        <Trans>Budget not found</Trans>
      </h1>
      <p>
        <Trans>
          This URL refers to a budget that is not available in this file.
        </Trans>
      </p>
    </main>
  );
}

export function BudgetSpaceProvider({
  fileId,
  children,
}: BudgetSpaceProviderProps) {
  const location = useLocation();
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
  if (budgetSpacesQuery.isPending) return null;
  if (budgetSpacesQuery.isError) {
    return (
      <FeatureErrorFallback
        error={budgetSpacesQuery.error}
        resetErrorBoundary={() => void budgetSpacesQuery.refetch()}
      />
    );
  }

  const budgetSpaces = budgetSpacesQuery.data.filter(
    budgetSpace => !budgetSpace.tombstone,
  );
  if (budgetSpaces.length === 0) {
    return (
      <FeatureErrorFallback
        error={new Error('No active budget was found in this file.')}
        resetErrorBoundary={() => void budgetSpacesQuery.refetch()}
      />
    );
  }

  const explicitBudgetMatch = location.pathname.match(/^\/spaces\/([^/]+)/);
  const explicitBudgetId = explicitBudgetMatch
    ? decodeURIComponent(explicitBudgetMatch[1])
    : null;
  const activeBudget = explicitBudgetId
    ? budgetSpaces.find(budgetSpace => budgetSpace.id === explicitBudgetId)
    : selectBudgetSpace(budgetSpaces, getLastSelectedBudgetSpaceId(fileId));

  if (explicitBudgetId && !activeBudget) return <BudgetNotFound />;

  const selectedBudget = activeBudget!;
  if (location.pathname === '/') {
    return <Navigate to={budgetRoutes.budget(selectedBudget.id)} replace />;
  }
  const canonicalLegacyPath = canonicalizeLegacyBudgetPath(
    location.pathname,
    selectedBudget.id,
  );
  if (canonicalLegacyPath) {
    return (
      <Navigate
        to={`${canonicalLegacyPath}${location.search}${location.hash}`}
        replace
      />
    );
  }

  return (
    <BudgetSpaceContext.Provider value={selectedBudget}>
      {explicitBudgetId && <RememberBudgetSelection fileId={fileId} />}
      {children}
    </BudgetSpaceContext.Provider>
  );
}

function RememberBudgetSelection({ fileId }: { fileId: string }) {
  const budgetSpace = useContext(BudgetSpaceContext);
  useEffect(() => {
    if (budgetSpace) rememberSelectedBudgetSpace(fileId, budgetSpace.id);
  }, [budgetSpace, fileId]);
  return null;
}
