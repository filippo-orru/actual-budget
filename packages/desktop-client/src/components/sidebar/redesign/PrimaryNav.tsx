import { useTranslation } from 'react-i18next';

import {
  SvgLibrary,
  SvgReports,
  SvgTuning,
  SvgWallet,
} from '@actual-app/components/icons/v1';
import { SvgCalendar3 } from '@actual-app/components/icons/v2';
import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { useIsTestEnv } from '#hooks/useIsTestEnv';
import { useSyncServerStatus } from '#hooks/useSyncServerStatus';
import { budgetRoutes } from '#util/budget-routes';

import { NavRow } from './NavRow';

export function PrimaryNav() {
  const { t } = useTranslation();
  const budgetId = useBudgetSpaceId();
  const syncServerStatus = useSyncServerStatus();
  const isTestEnv = useIsTestEnv();
  const isUsingServer = syncServerStatus !== 'no-server' || isTestEnv;

  return (
    <View
      data-testid="sidebar-primary-buttons"
      style={{
        flexShrink: 0,
        padding: `${spacing.xs}px ${spacing.sm}px 0`,
      }}
    >
      <NavRow
        title={t('Budget')}
        Icon={SvgWallet}
        to={budgetRoutes.budget(budgetId)}
      />
      <NavRow
        title={t('Reports')}
        Icon={SvgReports}
        to={budgetRoutes.reports(budgetId)}
      />
      <NavRow
        title={t('Schedules')}
        Icon={SvgCalendar3}
        to={budgetRoutes.schedules(budgetId)}
      />
      <NavRow
        title={t('Rules')}
        Icon={SvgTuning}
        to={budgetRoutes.rules(budgetId)}
      />
      {isUsingServer && (
        <NavRow
          title={t('Bank Sync')}
          Icon={SvgLibrary}
          to={budgetRoutes.bankSync(budgetId)}
        />
      )}
    </View>
  );
}
