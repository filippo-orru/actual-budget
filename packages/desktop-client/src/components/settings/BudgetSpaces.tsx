import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgAdd } from '@actual-app/components/icons/v1';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { useQuery } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { useOpenCreateBudgetSpace } from '#budget-spaces/useOpenCreateBudgetSpace';
import { Link } from '#components/common/Link';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { budgetRoutes } from '#util/budget-routes';

import { Setting } from './UI';

export function BudgetSpacesSettings() {
  const { t } = useTranslation();
  const [fileId] = useMetadataPref('id');
  const { data: budgetSpaces = [] } = useQuery(budgetSpaceQueries.list(fileId));
  const activeSpaces = budgetSpaces.filter(space => !space.tombstone);
  const multiBudgetEnabled = useFeatureFlag('multiCurrency');
  const openCreate = useOpenCreateBudgetSpace();

  return (
    <Setting
      primaryAction={
        multiBudgetEnabled && (
          <Button onPress={() => void openCreate()}>
            <SvgAdd width={10} height={10} style={{ marginRight: 5 }} />
            <Trans>Add budget space</Trans>
          </Button>
        )
      }
    >
      <Text>
        <Trans>
          <strong>Budget spaces</strong> each have their own currency,
          categories and accounts.
        </Trans>
      </Text>
      <View
        role="list"
        aria-label={t('Budget spaces')}
        style={{ gap: 5, width: '100%' }}
      >
        {activeSpaces.map(space => (
          <View
            key={space.id}
            role="listitem"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Text style={{ flex: 1, fontWeight: 500 }}>{space.name}</Text>
            <Text style={{ color: theme.pageTextSubdued }}>
              {space.currency_code || t('No currency')}
            </Text>
            <Link
              variant="internal"
              to={budgetRoutes.settings(space.id)}
              style={{ color: theme.pageTextLink }}
            >
              <Trans>Settings</Trans>
            </Link>
          </View>
        ))}
      </View>
    </Setting>
  );
}
