import { useQuery } from '@tanstack/react-query';

import { categoryQueries } from '#budget';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

export function useCategory(id?: string | null) {
  return useQuery({
    ...categoryQueries.list(useBudgetSpaceId()),
    select: data => data.list.find(c => c.id === id),
    enabled: !!id,
  });
}
