import { convertAmount } from '@actual-app/core/server/exchange-rates/convert';
import { getDecimalPlaces } from '@actual-app/core/shared/currencies';

export type AccountCurrencyInfo = {
  id: string;
  /** Effective currency of the account. */
  currency: string;
};

export type ConvertedAccount = {
  native: number;
  converted: number | null;
  rate: number | null;
};

export type ConvertedTotals = {
  /** Null if any needed rate is unavailable. */
  total: number | null;
  /** "FROM→TO" pairs whose rate is unavailable. */
  missingPairs: string[];
  perAccount: Record<string, ConvertedAccount>;
};

export function pairLabel(from: string, to: string) {
  return `${from} → ${to}`;
}

/**
 * Converts each account's native total into the global currency and sums the
 * converted totals. Each account total is converted and rounded once (never
 * per transaction). If any rate is unavailable, `total` is null.
 *
 * `rates` holds, per foreign currency, the rate to the global currency
 * (null when unavailable, missing when not loaded yet -> treated as null).
 */
export function aggregateConvertedTotal({
  accounts,
  nativeByAccount,
  globalCurrency,
  rates,
}: {
  accounts: AccountCurrencyInfo[];
  nativeByAccount: Record<string, number>;
  globalCurrency: string;
  rates: Record<string, number | null | undefined>;
}): ConvertedTotals {
  const perAccount: Record<string, ConvertedAccount> = {};
  const missing = new Set<string>();
  let total: number | null = 0;

  for (const account of accounts) {
    const native = nativeByAccount[account.id] ?? 0;

    if (account.currency === globalCurrency) {
      perAccount[account.id] = { native, converted: native, rate: 1 };
      if (total != null) {
        total += native;
      }
      continue;
    }

    const rate = rates[account.currency] ?? null;
    if (rate == null) {
      perAccount[account.id] = { native, converted: null, rate: null };
      missing.add(pairLabel(account.currency, globalCurrency));
      total = null;
      continue;
    }

    const converted = convertAmount(
      native,
      rate,
      getDecimalPlaces(account.currency),
      getDecimalPlaces(globalCurrency),
    );
    perAccount[account.id] = { native, converted, rate };
    if (total != null) {
      total += converted;
    }
  }

  return { total, missingPairs: [...missing], perAccount };
}
