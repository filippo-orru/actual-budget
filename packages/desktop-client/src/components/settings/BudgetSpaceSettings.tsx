import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { MOBILE_NAV_HEIGHT } from '#components/mobile/MobileNavTabs';
import { Page } from '#components/Page';
import { useBudgetSpace } from '#hooks/useBudgetSpace';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

import { BudgetTypeSettings } from './BudgetTypeSettings';
import { CurrencySettings } from './Currency';
import { Setting } from './UI';

export function BudgetSpaceSettings() {
  const { t } = useTranslation();
  const budgetSpace = useBudgetSpace();
  const queryClient = useQueryClient();
  const dispatch = useDispatch();
  const [fileId] = useMetadataPref('id');
  const { data: budgetSpaces = [] } = useQuery(budgetSpaceQueries.list(fileId));
  const canDeleteBudgetSpace =
    budgetSpaces.filter(space => !space.tombstone).length > 1;
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
    <Page header={t('Budget Space Settings')}>
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
                aria-label={t('Budget space name')}
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
            <Trans>Change the name used to identify this budget space.</Trans>
          </Text>
        </Setting>
        <CurrencySettings />
        <BudgetTypeSettings />
        {canDeleteBudgetSpace && (
          <Setting
            primaryAction={
              <Button
                variant="primary"
                onPress={() =>
                  dispatch(
                    pushModal({
                      modal: {
                        name: 'budget-space-delete',
                        options: {
                          budgetId: budgetSpace.id,
                          budgetName: budgetSpace.name,
                          currencyCode: budgetSpace.currency_code ?? '',
                        },
                      },
                    }),
                  )
                }
              >
                <Trans>Delete budget space</Trans>
              </Button>
            }
          >
            <Text>
              <Trans>Delete this budget space and all of its data.</Trans>
            </Text>
          </Setting>
        )}
      </View>
    </Page>
  );
}
