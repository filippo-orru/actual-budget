import { useQuery } from '@tanstack/react-query';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { reportQueries } from '#reports';

export function useReport(id?: string | null) {
  const budgetId = useBudgetSpaceId();
  return useQuery({
    ...reportQueries.list(budgetId),
    select: reports => reports.find(report => report.id === id),
    enabled: !!id,
  });
}
