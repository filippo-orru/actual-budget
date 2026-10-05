import { send } from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import { queryOptions } from '@tanstack/react-query';

function selectActive(accounts: AccountEntity[]) {
  return accounts.filter(account => !account.closed);
}

export const accountQueries = {
  all: () => ['accounts'],
  lists: (budgetId?: string) =>
    budgetId
      ? [...accountQueries.all(), budgetId, 'lists']
      : accountQueries.all(),
  list: (budgetId: string) =>
    queryOptions<AccountEntity[]>({
      queryKey: [...accountQueries.lists(budgetId)],
      queryFn: async () => {
        const accounts: AccountEntity[] = await send('accounts-get', {
          budgetId,
        });
        return accounts;
      },
      placeholderData: [],
      // Manually invalidated when accounts change
      staleTime: Infinity,
    }),
  listActive: (budgetId: string) =>
    queryOptions<AccountEntity[]>({
      ...accountQueries.list(budgetId),
      select: selectActive,
    }),
  listClosed: (budgetId: string) =>
    queryOptions<AccountEntity[]>({
      ...accountQueries.list(budgetId),
      select: accounts => accounts.filter(account => !!account.closed),
    }),
  listOnBudget: (budgetId: string) =>
    queryOptions<AccountEntity[]>({
      ...accountQueries.list(budgetId),
      select: accounts =>
        selectActive(accounts).filter(account => !account.offbudget),
    }),
  listOffBudget: (budgetId: string) =>
    queryOptions<AccountEntity[]>({
      ...accountQueries.list(budgetId),
      select: accounts =>
        selectActive(accounts).filter(account => !!account.offbudget),
    }),
};
