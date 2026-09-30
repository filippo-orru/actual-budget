import { convertAmount } from '@actual-app/core/server/exchange-rates/convert';
import { getDecimalPlaces } from '@actual-app/core/shared/currencies';
import { currentDay } from '@actual-app/core/shared/months';
import type { AccountEntity } from '@actual-app/core/types/models';

import { useAccounts } from './useAccounts';
import { useCurrencyRates } from './useExchangeRates';
import { useMultiCurrency } from './useMultiCurrency';

/**
 * How the balances of an account page header are shown:
 * - plain: native amounts, nothing converted (feature off, or no foreign
 *   account involved)
 * - single: one foreign account; native amounts with a converted tooltip
 * - mixed: a view with at least one foreign account; sums are converted
 */
export type BalanceMode =
  | { kind: 'plain' }
  | {
      kind: 'single';
      currency: string;
      globalCurrency: string;
      /** Today's rate; null when unavailable, undefined while loading. */
      rate: number | null | undefined;
    }
  | { kind: 'mixed' };

export function getViewAccounts(
  accounts: AccountEntity[],
  accountId: string | undefined,
): AccountEntity[] {
  switch (accountId) {
    case undefined:
    case '':
      return accounts;
    case 'onbudget':
      return accounts.filter(a => !a.closed && !a.offbudget);
    case 'offbudget':
      return accounts.filter(a => !a.closed && !!a.offbudget);
    case 'closed':
      return accounts.filter(a => !!a.closed);
    case 'uncategorized':
      return accounts.filter(a => !a.offbudget);
    default:
      return accounts.filter(a => a.id === accountId);
  }
}

export function useBalanceMode(
  account: AccountEntity | undefined,
  accountId: string | undefined,
): BalanceMode {
  const { isEnabled, globalCurrency, getAccountCurrency, isForeign } =
    useMultiCurrency();
  const { data: accounts = [] } = useAccounts();

  const singleForeignCurrency =
    isEnabled && account && isForeign(account)
      ? getAccountCurrency(account)
      : null;

  const { rates } = useCurrencyRates(
    singleForeignCurrency ? [singleForeignCurrency] : [],
    globalCurrency,
    currentDay(),
    { enabled: singleForeignCurrency != null },
  );

  if (!isEnabled) {
    return { kind: 'plain' };
  }
  if (account) {
    if (!singleForeignCurrency) {
      return { kind: 'plain' };
    }
    return {
      kind: 'single',
      currency: singleForeignCurrency,
      globalCurrency,
      rate: rates[singleForeignCurrency],
    };
  }
  const hasForeign = getViewAccounts(accounts, accountId).some(a =>
    isForeign(a),
  );
  return hasForeign ? { kind: 'mixed' } : { kind: 'plain' };
}

/** Converts a native amount of a `single` mode; null when the rate is missing. */
export function convertNative(
  mode: Extract<BalanceMode, { kind: 'single' }>,
  amount: number,
): number | null {
  if (mode.rate == null) {
    return null;
  }
  return convertAmount(
    amount,
    mode.rate,
    getDecimalPlaces(mode.currency),
    getDecimalPlaces(mode.globalCurrency),
  );
}
