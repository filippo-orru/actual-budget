import type { ExchangeRateProvider, ProviderResult } from './types';

const API_BASE_URL = 'https://api.frankfurter.dev/v2';

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

type FrankfurterRateResponse = Array<{
  date: string;
  base: string;
  quote: string;
  rate: number;
}>;

/**
 * Exchange rate provider using Frankfurter API (https://api.frankfurter.dev)
 * Supports multiple currencies and historical data via range queries.
 * For same-currency pairs, returns identity rate (1.0) without API call.
 */
export class FrankfurterProvider implements ExchangeRateProvider {
  name = 'frankfurter';

  constructor(private readonly now: () => Date = () => new Date()) {}

  supports(base: string, quote: string): boolean {
    // Frankfurter supports 3-letter currency codes
    return base.length === 3 && quote.length === 3;
  }

  async getRates(
    base: string,
    quote: string,
    startDate: string,
    endDate: string,
  ): Promise<ProviderResult> {
    try {
      const now = this.now();
      const today = toDay(now);

      // For same-currency pairs, return identity rate (1.0) without API call
      if (base === quote) {
        const rates: Array<{ date: string; rate: number }> = [];
        const DAY_MS = 24 * 60 * 60 * 1000;
        for (
          let t = new Date(startDate).getTime();
          t <= new Date(endDate).getTime();
          t += DAY_MS
        ) {
          const date = toDay(new Date(t));
          if (date <= today) {
            rates.push({ date, rate: 1.0 });
          }
        }
        const latestDate =
          rates.length > 0 ? rates[rates.length - 1].date : startDate;
        return { rates, latestDate, earliestDate: '1999-01-04' };
      }

      // Don't query beyond today
      const queryEndDate = endDate < today ? endDate : today;

      // Construct the API URL with date range and currency parameters
      const params = new URLSearchParams({
        from: startDate,
        to: queryEndDate,
        base,
        quotes: quote,
      });

      const url = `${API_BASE_URL}/rates?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `Frankfurter API error: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as FrankfurterRateResponse;

      // Filter to only include requested quote currency
      const rates = data
        .filter(item => item.quote === quote)
        .map(item => ({
          date: item.date,
          rate: item.rate,
        }));

      // Determine the latest date with data
      let latestDate = startDate;
      if (rates.length > 0) {
        latestDate = rates[rates.length - 1].date;
      }

      // Frankfurter historical data starts from 1999-01-04 (when ECB was established)
      const earliestDate = '1999-01-04';

      return { rates, latestDate, earliestDate };
    } catch (error) {
      console.error(
        `Failed to fetch rates from Frankfurter for ${base}/${quote}:`,
        error,
      );
      // Return empty result on error
      return {
        rates: [],
        latestDate: startDate,
        earliestDate: '1999-01-04',
      };
    }
  }
}
