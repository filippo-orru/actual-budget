import type {
  DashboardPageEntity,
  DashboardWidgetEntity,
} from '@actual-app/core/types/models';
import { useQuery } from '@tanstack/react-query';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { dashboardQueries } from '#reports';

export function useDashboardPages() {
  const budgetId = useBudgetSpaceId();
  return useQuery(dashboardQueries.listDashboardPages(budgetId));
}

export function useDashboardPageWidgets<W extends DashboardWidgetEntity>(
  dashboardPageId?: DashboardPageEntity['id'] | null,
) {
  const budgetId = useBudgetSpaceId();
  return useQuery(
    dashboardQueries.listDashboardPageWidgets<W>(dashboardPageId, budgetId),
  );
}
