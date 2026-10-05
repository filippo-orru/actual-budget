import { send } from '@actual-app/core/platform/client/connection';
import type { RuleConditionEntity } from '@actual-app/core/types/models';
import type {
  ForecastResult,
  ForecastSource,
} from '@actual-app/core/types/models/forecast';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';

type UseBalanceForecastParams = {
  accountIds?: string[];
  conditions?: RuleConditionEntity[];
  conditionsOp?: 'and' | 'or';
  startDate: string;
  endDate: string;
  includeAccountlessSchedules?: boolean;
  source?: ForecastSource;
  enabled?: boolean;
};

export function buildBalanceForecastRequest({
  budgetId,
  accountIds,
  conditions,
  conditionsOp,
  startDate,
  endDate,
  includeAccountlessSchedules,
  source = 'schedules',
}: UseBalanceForecastParams & { budgetId: string }) {
  return {
    budgetId,
    ...(accountIds === undefined ? {} : { accountIds }),
    ...(conditions === undefined ? {} : { conditions }),
    ...(conditionsOp === undefined ? {} : { conditionsOp }),
    startDate,
    endDate,
    ...(includeAccountlessSchedules === undefined
      ? {}
      : { includeAccountlessSchedules }),
    source,
  };
}

export function useBalanceForecast({
  accountIds,
  conditions,
  conditionsOp,
  startDate,
  endDate,
  includeAccountlessSchedules,
  source = 'schedules',
  enabled = true,
}: UseBalanceForecastParams) {
  const budgetId = useBudgetSpaceId();
  return useQuery({
    queryKey: [
      'balance-forecast',
      budgetId,
      {
        accountIds: accountIds ?? null,
        conditions: conditions ?? null,
        conditionsOp: conditionsOp ?? 'and',
        startDate,
        endDate,
        includeAccountlessSchedules: includeAccountlessSchedules ?? false,
        source,
      },
    ],
    queryFn: async (): Promise<ForecastResult> => {
      return send(
        'forecast/generate',
        buildBalanceForecastRequest({
          budgetId,
          accountIds,
          conditions,
          conditionsOp,
          startDate,
          endDate,
          includeAccountlessSchedules,
          source,
        }),
      );
    },
    placeholderData: keepPreviousData,
    enabled,
  });
}
