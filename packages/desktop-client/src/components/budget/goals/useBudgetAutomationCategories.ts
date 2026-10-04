import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { useCategories } from '#hooks/useCategories';

export function useBudgetAutomationCategories() {
  const { t } = useTranslation();
  const budgetId = useBudgetSpaceId();
  const { data: { grouped } = { grouped: [] } } = useCategories();
  const categories = useMemo(() => {
    const incomeGroups = grouped.filter(group => group.is_income);
    return [
      {
        id: '',
        budget_id: budgetId,
        name: t('Special categories'),
        categories: [
          {
            id: 'all income',
            budget_id: budgetId,
            group: '',
            name: t('Total of all income'),
          },
          {
            id: 'available funds',
            budget_id: budgetId,
            group: '',
            name: t('Available funds to budget'),
          },
        ],
      },
      ...incomeGroups.map(group => ({
        ...group,
        name: t('Income categories'),
      })),
    ];
  }, [budgetId, grouped, t]);

  return categories;
}
