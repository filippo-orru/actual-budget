import type { ReactNode } from 'react';

import type { AccountEntity } from '@actual-app/core/types/models';

import { useConvertedTotal } from '#hooks/useConvertedTotal';
import { useMultiCurrency } from '#hooks/useMultiCurrency';

import { AccountCurrencyProvider } from './AccountCurrencyProvider';
import { ConvertedTooltip } from './ConvertedAmount';

function ForeignAccountBalance({
  account,
  children,
}: {
  account: AccountEntity;
  children: ReactNode;
}) {
  const { globalCurrency, getAccountCurrency } = useMultiCurrency();
  const { perAccount, missingPairs } = useConvertedTotal([account.id]);

  return (
    <ConvertedTooltip
      converted={perAccount[account.id]?.converted}
      pair={
        missingPairs[0] ?? `${getAccountCurrency(account)} → ${globalCurrency}`
      }
    >
      {children}
    </ConvertedTooltip>
  );
}

type AccountBalanceCellProps = {
  account?: AccountEntity;
  children: ReactNode;
};

/**
 * Formats an account's native balance in the account currency. For a foreign
 * account, hovering shows the balance converted into the global currency.
 */
export function AccountBalanceCell({
  account,
  children,
}: AccountBalanceCellProps) {
  const { isForeign } = useMultiCurrency();

  if (!account) {
    return children;
  }

  return (
    <AccountCurrencyProvider account={account}>
      {isForeign(account) ? (
        <ForeignAccountBalance account={account}>
          {children}
        </ForeignAccountBalance>
      ) : (
        children
      )}
    </AccountCurrencyProvider>
  );
}
