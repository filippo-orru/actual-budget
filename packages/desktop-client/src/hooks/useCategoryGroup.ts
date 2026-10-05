import { useQuery } from '@tanstack/react-query';

import { categoryQueries } from '#budget';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

export function useCategoryGroup(id?: string | null) {
  return useQuery({
    ...categoryQueries.list(useBudgetSpaceId()),
    select: data => data.grouped.find(g => g.id === id),
    enabled: !!id,
  });
}
