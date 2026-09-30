import type { AccountEntity } from '@actual-app/core/types/models';

import { useAccounts } from './useAccounts';
import { useCurrencyFeature } from './useCurrencyFeature';
import { useFeatureFlag } from './useFeatureFlag';

type AccountRef =
  | AccountEntity['id']
  | Pick<AccountEntity, 'id' | 'currency'>
  | null
  | undefined;

export type UseMultiCurrencyResult = {
  isEnabled: boolean;
  globalCurrency: string;
  /** Effective currency of an account: its own currency or the global one. */
  getAccountCurrency: (account: AccountRef) => string;
  /** True if the account's effective currency differs from the global one. */
  isForeign: (account: AccountRef) => boolean;
};

/**
 * Multi-currency is enabled when the `multiCurrency` flag is on and the
 * currency feature is active (a global currency is selected).
 */
export function useMultiCurrency(): UseMultiCurrencyResult {
  const isFlagOn = useFeatureFlag('multiCurrency');
  const { isCurrencyActive, globalCurrency } = useCurrencyFeature();
  const { data: accounts = [] } = useAccounts();

  const isEnabled = isFlagOn && isCurrencyActive;

  function getAccountCurrency(account: AccountRef): string {
    if (account == null) {
      return globalCurrency;
    }
    const currency =
      typeof account === 'string'
        ? accounts.find(a => a.id === account)?.currency
        : (account.currency ??
          accounts.find(a => a.id === account.id)?.currency);
    return currency || globalCurrency;
  }

  function isForeign(account: AccountRef): boolean {
    return isEnabled && getAccountCurrency(account) !== globalCurrency;
  }

  return { isEnabled, globalCurrency, getAccountCurrency, isForeign };
}
