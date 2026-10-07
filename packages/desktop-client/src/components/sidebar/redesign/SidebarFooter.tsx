import { useTranslation } from 'react-i18next';

import { SvgCog, SvgTag, SvgUserGroup } from '@actual-app/components/icons/v1';
import { theme } from '@actual-app/components/theme';
import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';

import { budgetRoutes } from '#util/budget-routes';

import { NavRow } from './NavRow';

export function SidebarFooter() {
  const { t } = useTranslation();

  return (
    <View
      style={{
        flexShrink: 0,
        borderTop: `1px solid ${theme.sidebarBorder}`,
        padding: spacing.sm,
      }}
    >
      <NavRow
        title={t('Payees')}
        Icon={SvgUserGroup}
        to={budgetRoutes.payees()}
      />
      <NavRow title={t('Tags')} Icon={SvgTag} to={budgetRoutes.tags()} />
      <NavRow title={t('Settings')} Icon={SvgCog} to="/settings" />
    </View>
  );
}
