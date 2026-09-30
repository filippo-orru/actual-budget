import { Trans } from 'react-i18next';

import { Select } from '@actual-app/components/select';
import { View } from '@actual-app/components/view';
import type { TransObjectLiteral } from '@actual-app/core/types/util';

import { Checkbox } from '#components/forms';
import { useCurrencyOptions } from '#hooks/useCurrencyOptions';

export type AccountCurrencyValue = {
  useCustomCurrency: boolean;
  currency: string;
};

/** The currency code to store: the global code when not customised. */
export function resolveAccountCurrency(
  value: AccountCurrencyValue,
  globalCurrency: string,
): string {
  return value.useCustomCurrency && value.currency
    ? value.currency
    : globalCurrency;
}

type AccountCurrencyFieldProps = {
  value: AccountCurrencyValue;
  onChange: (value: AccountCurrencyValue) => void;
  globalCurrency: string;
  disabled?: boolean;
};

export function AccountCurrencyField({
  value,
  onChange,
  globalCurrency,
  disabled,
}: AccountCurrencyFieldProps) {
  const { currencyOptions } = useCurrencyOptions({ includeNone: false });

  return (
    <View style={{ gap: 8, marginTop: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Checkbox
          id="account-custom-currency"
          checked={value.useCustomCurrency}
          disabled={disabled}
          onChange={e =>
            onChange({
              ...value,
              useCustomCurrency: e.target.checked,
              currency: value.currency || globalCurrency,
            })
          }
        />
        <label htmlFor="account-custom-currency">
          <Trans>
            Use a different currency than the budget default (
            {{ currency: globalCurrency } as TransObjectLiteral})
          </Trans>
        </label>
      </View>
      {value.useCustomCurrency && (
        <Select
          id="account-currency-select"
          value={value.currency || globalCurrency}
          options={currencyOptions}
          disabled={disabled}
          onChange={currency => onChange({ ...value, currency })}
          style={{ width: '100%' }}
        />
      )}
    </View>
  );
}
