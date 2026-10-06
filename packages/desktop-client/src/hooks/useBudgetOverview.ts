import { useEffect, useState } from 'react';

import { q } from '@actual-app/core/shared/query';

import type { BudgetBalanceRow } from '#budget-spaces/overview';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { liveQuery } from '#queries/liveQuery';

const budgetOverviewQuery = q('transactions')
  .filter({ 'account.tombstone': false })
  .options({ splits: 'none' })
  .groupBy('account.budget_id')
  .select([
    { budgetId: 'account.budget_id' },
    { balance: { $sum: '$amount' } },
  ]);

/** Live native totals for all budgets in the loaded file. */
export function useBudgetOverview() {
  const [fileId] = useMetadataPref('id');
  const [rows, setRows] = useState<BudgetBalanceRow[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setRows(null);
    setError(null);
    const query = liveQuery<BudgetBalanceRow>(budgetOverviewQuery, {
      onData: data => setRows(data),
      onError: setError,
    });

    return () => query.unsubscribe();
  }, [fileId]);

  return { rows, isLoading: rows == null && error == null, error };
}
