import type { DashboardWidgetEntity } from '@actual-app/core/types/models';
import { useQuery } from '@tanstack/react-query';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { dashboardQueries } from '#reports';

type UseDashboardWidgetProps<W extends DashboardWidgetEntity> = Partial<
  Pick<W, 'id' | 'type'>
>;

export function useDashboardWidget<W extends DashboardWidgetEntity>({
  id,
  type,
}: UseDashboardWidgetProps<W>) {
  const budgetId = useBudgetSpaceId();
  return useQuery({
    ...dashboardQueries.listDashboardWidgets<W>(budgetId),
    select: widgets => widgets.find(w => w.id === id && w.type === type),
    enabled: !!id && !!type,
  });
}
