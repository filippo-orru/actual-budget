import { useQuery } from '@tanstack/react-query';

import { accountQueries } from '#accounts';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

export function useAccount(id: string) {
  const query = useQuery({
    ...accountQueries.list(useBudgetSpaceId()),
    select: data => data.find(c => c.id === id),
  });
  return query.data;
}
