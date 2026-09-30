import type { ReactNode } from 'react';

import type { AccountEntity } from '@actual-app/core/types/models';

import { CurrencyProvider } from '#components/CurrencyProvider';
import { useMultiCurrency } from '#hooks/useMultiCurrency';

type AccountCurrencyProviderProps = {
  account:
    | AccountEntity['id']
    | Pick<AccountEntity, 'id' | 'currency'>
    | null
    | undefined;
  children: ReactNode;
};

/**
 * Formats everything inside in the account's effective currency. A no-op
 * unless multi-currency is enabled.
 */
export function AccountCurrencyProvider({
  account,
  children,
}: AccountCurrencyProviderProps) {
  const { isEnabled, getAccountCurrency } = useMultiCurrency();

  if (!isEnabled || account == null) {
    return children;
  }

  return (
    <CurrencyProvider currencyCode={getAccountCurrency(account)}>
      {children}
    </CurrencyProvider>
  );
}
