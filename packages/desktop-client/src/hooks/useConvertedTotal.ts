import { currentDay } from '@actual-app/core/shared/months';
import { q, Query } from '@actual-app/core/shared/query';

import { aggregateConvertedTotal } from '#util/convertedTotals';
import type { ConvertedTotals } from '#util/convertedTotals';

import { useAccounts } from './useAccounts';
import { useCurrencyRates } from './useExchangeRates';
import { useMultiCurrency } from './useMultiCurrency';
import { useQuery } from './useQuery';

export type UseConvertedTotalResult = ConvertedTotals & {
  isLoading: boolean;
};

/**
 * Turns a transactions query into one summing amounts per account
 * (`account`, `amount`), keeping its filters and options.
 */
export function toSumByAccountQuery(query: Query): Query {
  return new Query({
    ...query.serialize(),
    selectExpressions: ['account', { amount: { $sum: '$amount' } }],
    groupExpressions: ['account'],
    orderExpressions: [],
    calculation: false,
    limit: null,
    offset: null,
  });
}

type SumRow = { account: string; amount: number };

/**
 * Converts the per-account sums of `query` into the global currency.
 * `query` must be a transactions query. Pass `null` to disable.
 * `extraNative` is added to the native sum of the given accounts (for
 * example scheduled amounts that are not in the database).
 */
export function useConvertedQueryTotal(
  query: Query | null,
  extraNative: Record<string, number> = {},
): UseConvertedTotalResult {
  const { globalCurrency, isEnabled, getAccountCurrency } = useMultiCurrency();
  const { data: allAccounts = [] } = useAccounts();

  const queryKey = query ? query.serializeAsString() : null;
  const { data: rows, isLoading: isQueryLoading } = useQuery<SumRow>(
    () =>
      queryKey && isEnabled
        ? toSumByAccountQuery(new Query(JSON.parse(queryKey)))
        : null,
    [queryKey, isEnabled],
  );

  const nativeByAccount: Record<string, number> = {};
  for (const row of rows ?? []) {
    nativeByAccount[row.account] =
      (nativeByAccount[row.account] ?? 0) + (row.amount ?? 0);
  }
  for (const [accountId, amount] of Object.entries(extraNative)) {
    nativeByAccount[accountId] = (nativeByAccount[accountId] ?? 0) + amount;
  }

  const involvedIds = Object.keys(nativeByAccount);
  const accounts = involvedIds.map(id => ({
    id,
    currency: getAccountCurrency(allAccounts.find(a => a.id === id) ?? id),
  }));
  const foreignCurrencies = [
    ...new Set(
      accounts.map(a => a.currency).filter(code => code !== globalCurrency),
    ),
  ].sort();

  const { rates, isLoading: isRatesLoading } = useCurrencyRates(
    foreignCurrencies,
    globalCurrency,
    currentDay(),
    { enabled: isEnabled },
  );

  const result = aggregateConvertedTotal({
    accounts,
    nativeByAccount,
    globalCurrency,
    rates,
  });

  return {
    ...result,
    isLoading: isQueryLoading || isRatesLoading,
  };
}

/**
 * Converted total (and per-account breakdown) for a set of accounts, updated
 * live when their transactions change.
 */
export function useConvertedTotal(
  accountIds: string[],
): UseConvertedTotalResult {
  // The query object is rebuilt each render; the hook keys on its content.
  const query =
    accountIds.length > 0
      ? q('transactions').filter({ account: { $oneof: accountIds } })
      : null;

  return useConvertedQueryTotal(query);
}
