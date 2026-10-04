import { send } from '@actual-app/core/platform/client/connection';
import type { BudgetSpaceEntity } from '@actual-app/core/types/models';
import { queryOptions } from '@tanstack/react-query';

export const budgetSpaceQueries = {
  all: () => ['budget-spaces'] as const,
  list: (fileId: string | undefined) =>
    queryOptions<BudgetSpaceEntity[]>({
      queryKey: [...budgetSpaceQueries.all(), fileId, 'list'],
      queryFn: async () => send('budget-spaces/get'),
      // Budget-space changes are invalidated explicitly when mutations are added.
      staleTime: Infinity,
    }),
};
