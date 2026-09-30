import { createMutex } from '#util/mutex';

import { getRows, upsertRows } from './exchange-rates-db';
import type { ExchangeRateRow } from './exchange-rates-db';
import { FrankfurterProvider } from './providers/frankfurter';
import type { ExchangeRateProvider } from './providers/types';

const PENDING_TTL_MS = 12 * 60 * 60 * 1000;

export const defaultProvider: ExchangeRateProvider = new FrankfurterProvider();

const mutexes = new Map<string, ReturnType<typeof createMutex>>();

function getMutex(base: string, quote: string) {
  const key = `${base}/${quote}`;
  let mutex = mutexes.get(key);
  if (!mutex) {
    mutex = createMutex();
    mutexes.set(key, mutex);
  }
  return mutex;
}

function isNeeded(row: ExchangeRateRow | undefined, now: Date): boolean {
  if (!row) {
    return true;
  }
  if (row.is_final === 1) {
    return false;
  }
  return now.getTime() - new Date(row.fetched_at).getTime() > PENDING_TTL_MS;
}

export type GetRatesOptions = {
  provider?: ExchangeRateProvider;
  now?: () => Date;
};

/**
 * Returns one row per requested date, in request order.
 * Uses the Frankfurter API provider to fetch real exchange rates.
 */
export function getRatesForDates(
  base: string,
  quote: string,
  dates: string[],
  { provider = defaultProvider, now = () => new Date() }: GetRatesOptions = {},
): Promise<ExchangeRateRow[]> {
  return getMutex(
    base,
    quote,
  )(async () => {
    const current = now();
    const cached = new Map(
      getRows(base, quote, dates).map(row => [row.date, row]),
    );
    const needed = [...new Set(dates)]
      .filter(date => isNeeded(cached.get(date), current))
      .sort();

    if (needed.length > 0) {
      const result = await provider.getRates(
        base,
        quote,
        needed[0],
        needed[needed.length - 1],
      );
      const published = new Map(result.rates.map(r => [r.date, r.rate]));
      const fetchedAt = current.toISOString();
      const fresh: ExchangeRateRow[] = needed.map(date => {
        const rate = published.get(date);
        if (rate != null) {
          return {
            base,
            quote,
            date,
            rate,
            is_final: 1,
            fetched_at: fetchedAt,
          };
        }
        // No rate: final if the provider's answer for this date can't change
        // (before its history starts, or on/before its latest published date).
        const isFinal = date < result.earliestDate || date <= result.latestDate;
        return {
          base,
          quote,
          date,
          rate: null,
          is_final: isFinal ? 1 : 0,
          fetched_at: fetchedAt,
        };
      });
      upsertRows(fresh);
      for (const row of fresh) {
        cached.set(row.date, row);
      }
    }

    return dates.map(date => cached.get(date)!);
  });
}
