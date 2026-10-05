import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { getCurrency } from '@actual-app/core/shared/currencies';
import { css } from '@emotion/css';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { Checkbox } from '#components/forms';
import { useBudgetSpace } from '#hooks/useBudgetSpace';
import { useCurrencyOptions } from '#hooks/useCurrencyOptions';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useSyncedPref } from '#hooks/useSyncedPref';

import { Column, Setting } from './UI';

export function CurrencySettings() {
  const { t } = useTranslation();
  const budgetSpace = useBudgetSpace();
  const [fileId] = useMetadataPref('id');
  const queryClient = useQueryClient();
  const { currencyOptions } = useCurrencyOptions();
  const { data: budgetSpaces = [] } = useQuery(budgetSpaceQueries.list(fileId));
  const [isSaving, setIsSaving] = useState(false);
  const selectedCurrencyCode = budgetSpace.currency_code ?? '';
  const canUseNone =
    budgetSpaces.filter(space => !space.tombstone).length === 1;
  const options = canUseNone
    ? currencyOptions
    : currencyOptions.filter(([code]) => code !== '');

  async function onCurrencyChange(code: string) {
    if (code === selectedCurrencyCode) return;
    const confirmed = window.confirm(
      t('Changing currency will not convert existing amounts. Continue?'),
    );
    if (!confirmed) return;

    setIsSaving(true);
    try {
      await send('budget-spaces/update', {
        id: budgetSpace.id,
        currencyCode: code,
      });
      await queryClient.invalidateQueries({
        queryKey: budgetSpaceQueries.all(),
      });
    } finally {
      setIsSaving(false);
    }
  }

  const currency = getCurrency(selectedCurrencyCode);

  return (
    <Setting
      primaryAction={
        <Column title={t('Budget currency')}>
          <Select
            value={selectedCurrencyCode}
            onChange={code => void onCurrencyChange(code)}
            options={options}
            className={css({ width: '100%' })}
            disabled={isSaving}
          />
        </Column>
      }
    >
      <Text>
        <Trans>
          Changing this budget's display currency relabels existing amounts and
          does not convert them. New amounts use the selected currency's decimal
          places.
        </Trans>
      </Text>
      {!canUseNone && (
        <Text>
          <Trans>
            Currency cannot be cleared while this file contains multiple
            budgets.
          </Trans>
        </Text>
      )}
      <Text>
        <Trans>
          Current currency: {{ currency: currency.code || t('None') }}
        </Trans>
      </Text>
    </Setting>
  );
}

export function CurrencyFormattingSettings() {
  const { t } = useTranslation();
  const budgetSpace = useBudgetSpace();
  const selectedCurrency = getCurrency(budgetSpace.currency_code ?? '');
  const [symbolPosition, setSymbolPosition] = useSyncedPref(
    'currencySymbolPosition',
  );
  const [spaceEnabled, setSpaceEnabled] = useSyncedPref(
    'currencySpaceBetweenAmountAndSymbol',
  );
  const symbol = selectedCurrency.symbol || '$';
  const space = spaceEnabled === 'true' ? ' ' : '';
  const symbolPositionOptions: [string, string][] = [
    ['before', `${t('Before amount')} (${t('e.g.')} ${symbol}${space}100)`],
    ['after', `${t('After amount')} (${t('e.g.')} 100${space}${symbol})`],
  ];

  return (
    <Setting
      primaryAction={
        <View style={{ display: 'flex', flexDirection: 'row', gap: '1.5em' }}>
          <Column title={t('Symbol Position')}>
            <Select
              value={symbolPosition || 'before'}
              onChange={value => setSymbolPosition(value)}
              options={symbolPositionOptions}
              className={css({ width: '100%' })}
            />
          </Column>
          <Column title={t('Spacing')}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Checkbox
                id="settings-spaceEnabled"
                checked={spaceEnabled === 'true'}
                onChange={event =>
                  setSpaceEnabled(
                    event.currentTarget.checked ? 'true' : 'false',
                  )
                }
              />
              <Trans>Add space between amount and symbol</Trans>
            </label>
          </Column>
        </View>
      }
    >
      <Text>
        <Trans>
          Symbol position and spacing are shared display preferences for all
          budgets.
        </Trans>
      </Text>
    </Setting>
  );
}
