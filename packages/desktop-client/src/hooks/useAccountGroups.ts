import { useQuery } from '@tanstack/react-query';

import { accountGroupQueries } from '#account-groups';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

export function useAccountGroups() {
  return useQuery(accountGroupQueries.list(useBudgetSpaceId()));
}
