import { useQuery } from '@tanstack/react-query';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { payeeQueries } from '#payees';

export function usePayeeRuleCounts() {
  const budgetId = useBudgetSpaceId();
  return useQuery(payeeQueries.ruleCounts(budgetId));
}
