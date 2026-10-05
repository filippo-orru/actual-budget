import { groupById } from '@actual-app/core/shared/util';
import { useQuery } from '@tanstack/react-query';

import { categoryQueries } from '#budget';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

export function useCategories() {
  return useQuery(categoryQueries.list(useBudgetSpaceId()));
}

export function useCategoriesById() {
  return useQuery({
    ...categoryQueries.list(useBudgetSpaceId()),
    select: data => {
      return {
        list: groupById(data.list),
        grouped: groupById(data.grouped),
      };
    },
  });
}
