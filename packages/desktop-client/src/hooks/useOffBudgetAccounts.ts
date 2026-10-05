import { useQuery } from '@tanstack/react-query';

import { accountQueries } from '#accounts';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

export function useOffBudgetAccounts() {
  return useQuery(accountQueries.listOffBudget(useBudgetSpaceId()));
}
