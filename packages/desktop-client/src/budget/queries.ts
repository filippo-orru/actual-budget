import { send } from '@actual-app/core/platform/client/connection';
import type {
  CategoryEntity,
  CategoryGroupEntity,
} from '@actual-app/core/types/models';
import { queryOptions } from '@tanstack/react-query';
import i18n from 'i18next';

type CategoryViews = {
  grouped: CategoryGroupEntity[];
  list: CategoryEntity[];
};

export const categoryQueries = {
  all: () => ['categories'],
  lists: (budgetId?: string) =>
    budgetId
      ? [...categoryQueries.all(), budgetId, 'lists']
      : categoryQueries.all(),
  list: (budgetId: string) =>
    queryOptions<CategoryViews>({
      queryKey: [...categoryQueries.lists(budgetId)],
      queryFn: async () => {
        const categories = await send('get-categories', { budgetId });
        return translateStartingBalances(categories);
      },
      placeholderData: {
        grouped: [],
        list: [],
      },
      // Manually invalidated when categories change
      staleTime: Infinity,
    }),
};

function translateStartingBalances(categories: {
  grouped: CategoryGroupEntity[];
  list: CategoryEntity[];
}): CategoryViews {
  return {
    list: translateStartingBalancesCategories(categories.list) ?? [],
    grouped: categories.grouped.map(group => ({
      ...group,
      categories: translateStartingBalancesCategories(group.categories),
    })),
  };
}

function translateStartingBalancesCategories(
  categories: CategoryEntity[] | undefined,
): CategoryEntity[] | undefined {
  return categories
    ? categories.map(cat => translateStartingBalancesCategory(cat))
    : undefined;
}

function translateStartingBalancesCategory(
  category: CategoryEntity,
): CategoryEntity {
  return {
    ...category,
    name:
      category.name?.toLowerCase() === 'starting balances'
        ? i18n.t('Starting Balances')
        : category.name,
  };
}
