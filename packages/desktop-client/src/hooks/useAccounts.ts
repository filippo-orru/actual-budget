import { useQuery } from '@tanstack/react-query';

import { accountQueries } from '#accounts';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

export function useAccounts() {
  return useQuery(accountQueries.list(useBudgetSpaceId()));
}
