import { useQuery } from '@tanstack/react-query';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { reportQueries } from '#reports';

export function useReports() {
  const budgetId = useBudgetSpaceId();
  return useQuery(reportQueries.list(budgetId));
}
