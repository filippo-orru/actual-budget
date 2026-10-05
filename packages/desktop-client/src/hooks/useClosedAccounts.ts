import { useQuery } from '@tanstack/react-query';

import { accountQueries } from '#accounts';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

export function useClosedAccounts() {
  return useQuery(accountQueries.listClosed(useBudgetSpaceId()));
}
