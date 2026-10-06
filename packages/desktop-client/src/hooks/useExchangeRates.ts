import { send } from '@actual-app/core/platform/client/connection';
import { useQueries, useQuery } from '@tanstack/react-query';

type RatesByDate = Record<string, number | null>;
type ExchangeRatesResult = { rates: RatesByDate; offline: boolean };

const ONE_HOUR = 60 * 60 * 1000;

function exchangeRateQuery(from: string, to: string, dates: string[]) {
  return {
    queryKey: ['exchange-rates', from, to, dates],
    queryFn: async (): Promise<ExchangeRatesResult> =>
      send('exchange-rates-get', { from, to, dates }),
    staleTime: ONE_HOUR,
  };
}

/**
 * Rates (units of `to` per one unit of `from`) for the given dates. A rate
 * is null when unavailable.
 */
export function useExchangeRates(
  from: string,
  to: string,
  dates: string[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    ...exchangeRateQuery(from, to, dates),
    select: result => result.rates,
    enabled: enabled && from !== '' && to !== '' && dates.length > 0,
  });
}

/**
 * One rate per currency for a single date (used for today's rate). The
 * result maps currency -> rate (null when unavailable, undefined while
 * loading).
 */
export function useCurrencyRates(
  currencies: string[],
  to: string,
  date: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQueries({
    queries: currencies.map(from => ({
      ...exchangeRateQuery(from, to, [date]),
      enabled: enabled && to !== '',
    })),
    combine: results => ({
      isLoading: results.some(result => result.isLoading),
      rates: Object.fromEntries(
        currencies.map((currency, index) => {
          const data = results[index]?.data;
          return [currency, data === undefined ? undefined : data.rates[date]];
        }),
      ) as Record<string, number | null | undefined>,
      offlineCurrencies: currencies.filter(
        (_, index) => results[index]?.data?.offline,
      ),
      failedCurrencies: currencies.filter(
        (_, index) => results[index]?.isError,
      ),
    }),
  });
}
