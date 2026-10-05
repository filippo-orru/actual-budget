import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import type {
  CustomReportEntity,
  DashboardPageEntity,
  DashboardWidgetEntity,
} from '@actual-app/core/types/models';
import { queryOptions } from '@tanstack/react-query';

import { aqlQuery } from '#queries/aqlQuery';

export const reportQueries = {
  all: () => ['reports'],
  lists: () => [...reportQueries.all(), 'lists'],
  list: (budgetId: string) =>
    queryOptions<CustomReportEntity[]>({
      queryKey: [...reportQueries.lists(), budgetId],
      queryFn: async () => {
        return await send('report/get', { budgetId });
      },
    }),
};

export const dashboardQueries = {
  all: () => ['dashboards'],
  lists: () => [...dashboardQueries.all(), 'lists'],
  listDashboardWidgets: <T extends DashboardWidgetEntity>(budgetId: string) =>
    queryOptions<T[]>({
      queryKey: [...dashboardQueries.lists(), 'widgets', budgetId],
      queryFn: async () => {
        const { data }: { data: T[] } = await aqlQuery(
          q('dashboard')
            .filter({ 'dashboard_page_id.budget_id': budgetId })
            .select('*'),
        );
        return data;
      },
    }),
  listDashboardPageWidgets: <T extends DashboardWidgetEntity>(
    dashboardPageId: DashboardPageEntity['id'] | null | undefined,
    budgetId: string,
  ) =>
    queryOptions<T[]>({
      ...dashboardQueries.listDashboardWidgets<T>(budgetId),
      select: widgets =>
        widgets.filter(w => w.dashboard_page_id === dashboardPageId),
      enabled: !!dashboardPageId,
    }),
  listDashboardPages: (budgetId: string) =>
    queryOptions<DashboardPageEntity[]>({
      queryKey: [...dashboardQueries.lists(), 'pages', budgetId],
      queryFn: async () => {
        const { data }: { data: DashboardPageEntity[] } = await aqlQuery(
          q('dashboard_pages').filter({ budget_id: budgetId }).select('*'),
        );
        return data.map(page => ({ ...page, name: page.name ?? '' }));
      },
    }),
};
