import { send } from '@actual-app/core/platform/client/connection';
import type { AccountGroupEntity } from '@actual-app/core/types/models';
import { queryOptions } from '@tanstack/react-query';

export const accountGroupQueries = {
  all: () => ['account-groups'],
  lists: (budgetId?: string) =>
    budgetId
      ? [...accountGroupQueries.all(), budgetId, 'lists']
      : accountGroupQueries.all(),
  list: (budgetId: string) =>
    queryOptions<AccountGroupEntity[]>({
      queryKey: [...accountGroupQueries.lists(budgetId)],
      queryFn: () => send('account-groups-get', { budgetId }),
      placeholderData: [],
      staleTime: Infinity,
    }),
};
