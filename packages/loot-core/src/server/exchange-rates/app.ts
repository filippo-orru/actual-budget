import * as asyncStorage from '#platform/server/asyncStorage';
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import { post } from '#server/post';
import { getServer } from '#server/server-config';

import { readRows, writeRows } from './cache';
import {
  canonicalPair,
  needsFetch,
  resolveRates,
  withLookback,
} from './lookup';
import type { RateRow } from './lookup';

export type ExchangeRatesHandlers = {
  'exchange-rates-get': typeof getExchangeRates;
};

export type ExchangeRatesGetResult = {
  /** Keyed by requested date; rate from -> to; null = unavailable. */
  rates: Record<string, number | null>;
  /** False if any requested date resolved to null. */
  isComplete: boolean;
  /** True if a needed fetch could not reach the server. */
  offline: boolean;
};

const MAX_DATES_PER_REQUEST = 20000;

type ServerRow = { date: string; rate: number | null; is_final: boolean };

// In-flight fetches per pair, so concurrent callers share one request.
const inFlight = new Map<string, Promise<boolean>>();

// Fetches the dates that need refreshing; resolves to true if we're offline.
async function fetchMissing(
  base: string,
  quote: string,
  dates: string[],
): Promise<boolean> {
  const serverConfig = getServer();
  if (!serverConfig) {
    return true;
  }
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) {
    return true;
  }

  // Re-check against the cache: another in-flight call may have filled it.
  const now = new Date();
  const cached = new Map(
    readRows(base, quote, dates).map(row => [row.date, row]),
  );
  const needed = dates.filter(date => needsFetch(cached.get(date), now));
  if (needed.length === 0) {
    return false;
  }

  try {
    for (let i = 0; i < needed.length; i += MAX_DATES_PER_REQUEST) {
      const chunk = needed.slice(i, i + MAX_DATES_PER_REQUEST);
      const res = await post(
        serverConfig.EXCHANGE_RATES_SERVER + '/rates',
        { base, quote, dates: chunk },
        { 'X-ACTUAL-TOKEN': userToken },
      );
      const rows: ServerRow[] = res?.rows ?? [];
      const fetchedAt = new Date().toISOString();
      writeRows(
        rows.map(
          (row): RateRow => ({
            base,
            quote,
            date: row.date,
            rate: row.rate,
            is_final: row.is_final ? 1 : 0,
            fetched_at: fetchedAt,
          }),
        ),
      );
    }
    return false;
  } catch (error) {
    logger.warn('Unable to fetch exchange rates', error);
    return true;
  }
}

async function getExchangeRates({
  from,
  to,
  dates,
}: {
  from: string;
  to: string;
  dates: string[];
}): Promise<ExchangeRatesGetResult> {
  const uniqueDates = [...new Set(dates)];

  if (from === to) {
    return {
      rates: Object.fromEntries(uniqueDates.map(date => [date, 1])),
      isComplete: true,
      offline: false,
    };
  }

  const { base, quote, inverted } = canonicalPair(from, to);
  const lookupDates = withLookback(uniqueDates);

  const now = new Date();
  const cached = new Map(
    readRows(base, quote, lookupDates).map(row => [row.date, row]),
  );
  const needed = lookupDates.filter(date => needsFetch(cached.get(date), now));

  let offline = false;
  if (needed.length > 0) {
    const key = `${base}/${quote}`;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = fetchMissing(base, quote, needed).finally(() =>
        inFlight.delete(key),
      );
      inFlight.set(key, pending);
    } else {
      // Join the running fetch, then fetch anything it didn't cover.
      const joined = pending;
      pending = joined.then(async wasOffline =>
        wasOffline ? true : fetchMissing(base, quote, needed),
      );
    }
    offline = await pending;
  }

  const resolved = resolveRates(
    readRows(base, quote, lookupDates),
    uniqueDates,
  );
  const rates: Record<string, number | null> = {};
  for (const date of uniqueDates) {
    const rate = resolved[date];
    rates[date] = rate == null ? null : inverted ? 1 / rate : rate;
  }

  return {
    rates,
    isComplete: uniqueDates.every(date => rates[date] != null),
    offline,
  };
}

export const app = createApp<ExchangeRatesHandlers>();
app.method('exchange-rates-get', getExchangeRates);
