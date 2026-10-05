import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { useQueryClient } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { MOBILE_NAV_HEIGHT } from '#components/mobile/MobileNavTabs';
import { Page } from '#components/Page';
import { useBudgetSpace } from '#hooks/useBudgetSpace';

import { BudgetTypeSettings } from './BudgetTypeSettings';
import { CurrencySettings } from './Currency';
import { Setting } from './UI';

export function BudgetSpaceSettings() {
  const { t } = useTranslation();
  const budgetSpace = useBudgetSpace();
  const queryClient = useQueryClient();
  const [name, setName] = useState(budgetSpace.name);
  const [isSavingName, setIsSavingName] = useState(false);

  async function saveName() {
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName === budgetSpace.name) return;

    setIsSavingName(true);
    try {
      await send('budget-spaces/update', {
        id: budgetSpace.id,
        name: normalizedName,
      });
      await queryClient.invalidateQueries({
        queryKey: budgetSpaceQueries.all(),
      });
    } finally {
      setIsSavingName(false);
    }
  }

  return (
    <Page header={budgetSpace.name}>
      <View
        data-testid="budget-space-settings"
        style={{
          marginTop: 10,
          flexShrink: 0,
          maxWidth: 530,
          width: '100%',
          gap: 30,
          paddingBottom: MOBILE_NAV_HEIGHT,
        }}
      >
        <Setting
          primaryAction={
            <View style={{ flexDirection: 'row', gap: 8, width: '100%' }}>
              <Input
                aria-label={t('Budget name')}
                value={name}
                onChange={event => setName(event.currentTarget.value)}
              />
              <ButtonWithLoading
                onPress={saveName}
                isLoading={isSavingName}
                isDisabled={!name.trim() || name.trim() === budgetSpace.name}
              >
                <Trans>Save name</Trans>
              </ButtonWithLoading>
            </View>
          }
        >
          <Text>
            <Trans>Change the name used to identify this budget.</Trans>
          </Text>
        </Setting>
        <CurrencySettings />
        <BudgetTypeSettings />
      </View>
    </Page>
  );
}
