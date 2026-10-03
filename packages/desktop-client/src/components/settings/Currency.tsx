import React, { useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { getCurrency } from '@actual-app/core/shared/currencies';
import { css } from '@emotion/css';

import { Checkbox } from '#components/forms';
import { useCurrencyOptions } from '#hooks/useCurrencyOptions';
import { useSyncedPref } from '#hooks/useSyncedPref';

import { Column, Setting } from './UI';

export function CurrencySettings() {
  const { t } = useTranslation();

  const { currencyOptions } = useCurrencyOptions();

  const [defaultCurrencyCode, setDefaultCurrencyCodePref] = useSyncedPref(
    'defaultCurrencyCode',
  );
  const selectedCurrencyCode = defaultCurrencyCode || '';

  const [symbolPosition, setSymbolPositionPref] = useSyncedPref(
    'currencySymbolPosition',
  );
  const [spaceEnabled, setSpaceEnabledPref] = useSyncedPref(
    'currencySpaceBetweenAmountAndSymbol',
  );
  const [, setNumberFormatPref] = useSyncedPref('numberFormat');
  const [, setHideFractionPref] = useSyncedPref('hideFraction');

  const selectButtonClassName = css({
    '&[data-hovered]': {
      backgroundColor: theme.buttonNormalBackgroundHover,
    },
  });

  const handleCurrencyChange = (code: string) => {
    setDefaultCurrencyCodePref(code);
    if (code !== '') {
      const cur = getCurrency(code);
      setNumberFormatPref(cur.numberFormat);
      setHideFractionPref(cur.decimalPlaces === 0 ? 'true' : 'false');
      setSpaceEnabledPref(cur.symbolFirst ? 'false' : 'true');
      setSymbolPositionPref(cur.symbolFirst ? 'before' : 'after');
    }
  };

  const symbolPositionOptions = useMemo(() => {
    const selectedCurrency = getCurrency(selectedCurrencyCode);
    const symbol = selectedCurrency.symbol || '$';
    const space = spaceEnabled === 'true' ? ' ' : '';

    return [
      {
        value: 'before',
        label: `${t('Before amount')} (${t('e.g.')} ${symbol}${space}100)`,
      },
      {
        value: 'after',
        label: `${t('After amount')} (${t('e.g.')} 100${space}${symbol})`,
      },
    ];
  }, [selectedCurrencyCode, spaceEnabled, t]);

  return (
    <Setting
      primaryAction={
        <View
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '1.5em',
            width: '100%',
          }}
        >
          <View style={{ display: 'flex', flexDirection: 'row', gap: '1.5em' }}>
            <Column title={t('Default Currency')}>
              <Select
                value={selectedCurrencyCode}
                onChange={handleCurrencyChange}
                options={currencyOptions}
                className={selectButtonClassName}
                style={{ width: '100%' }}
              />
            </Column>

            <Column
              title={t('Symbol Position')}
              style={{
                visibility: selectedCurrencyCode === '' ? 'hidden' : 'visible',
              }}
            >
              <Select
                value={symbolPosition || 'before'}
                onChange={value => setSymbolPositionPref(value)}
                options={symbolPositionOptions.map(f => [f.value, f.label])}
                className={selectButtonClassName}
                style={{ width: '100%' }}
                disabled={selectedCurrencyCode === ''}
              />
            </Column>
          </View>

          {selectedCurrencyCode !== '' && (
            <View
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'flex-start',
              }}
            >
              <Checkbox
                id="settings-spaceEnabled"
                checked={spaceEnabled === 'true'}
                onChange={e =>
                  setSpaceEnabledPref(e.target.checked ? 'true' : 'false')
                }
              />
              <label
                htmlFor="settings-spaceEnabled"
                style={{ marginLeft: '0.5em' }}
              >
                <Trans>Add space between amount and symbol</Trans>
              </label>
            </View>
          )}
        </View>
      }
    >
      <Text>
        <Trans>
          <strong>Currency settings</strong> affect how amounts are displayed
          throughout the application. Changing the currency will affect the
          number format, symbol position, and whether fractions are shown. These
          can be adjusted after the currency is set.
        </Trans>
      </Text>
    </Setting>
  );
}
