import type { ExchangeRateProvider, ProviderResult } from './types';

// Plausible fixed values (USD per one unit of the currency). Must be kept in
// sync with the codes in packages/loot-core/src/shared/currencies.ts.
const USD_PER_UNIT: Record<string, number> = {
  AED: 0.2723,
  ARS: 0.001,
  AUD: 0.65,
  BRL: 0.18,
  BYN: 0.31,
  CAD: 0.73,
  CHF: 1.12,
  CLP: 0.00105,
  CNY: 0.138,
  COP: 0.00024,
  CRC: 0.00195,
  CZK: 0.043,
  DKK: 0.145,
  DOP: 0.0168,
  EGP: 0.0205,
  EUR: 1.08,
  GBP: 1.27,
  GTQ: 0.129,
  HKD: 0.128,
  HUF: 0.0027,
  IDR: 0.000062,
  ILS: 0.27,
  INR: 0.012,
  IRR: 0.0000238,
  JMD: 0.0064,
  JPY: 0.0067,
  KRW: 0.00073,
  LKR: 0.0033,
  MDL: 0.056,
  MKD: 0.0175,
  MXN: 0.055,
  MYR: 0.21,
  PEN: 0.27,
  PHP: 0.0175,
  PKR: 0.0036,
  PLN: 0.25,
  QAR: 0.2747,
  RON: 0.217,
  RSD: 0.0092,
  RUB: 0.011,
  SAR: 0.2667,
  SEK: 0.095,
  SGD: 0.74,
  THB: 0.028,
  TRY: 0.031,
  TWD: 0.031,
  UAH: 0.024,
  USD: 1,
  UYU: 0.025,
  UZS: 0.000079,
};

const EARLIEST_DATE = '2000-01-03';
const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWeekday(date: Date): boolean {
  const dow = date.getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** Fixed rates, no network calls. Publishes on Mon-Fri only. */
export class HardcodedProvider implements ExchangeRateProvider {
  name = 'hardcoded';

  constructor(private readonly now: () => Date = () => new Date()) {}

  supports(base: string, quote: string): boolean {
    return base in USD_PER_UNIT && quote in USD_PER_UNIT;
  }

  private latestDate(): string {
    // Most recent weekday strictly before today (UTC).
    const d = toDate(toDay(this.now()));
    do {
      d.setTime(d.getTime() - DAY_MS);
    } while (!isWeekday(d));
    return toDay(d);
  }

  async getRates(
    base: string,
    quote: string,
    startDate: string,
    endDate: string,
  ): Promise<ProviderResult> {
    const latestDate = this.latestDate();
    const rate = USD_PER_UNIT[base] / USD_PER_UNIT[quote];
    const start = startDate > EARLIEST_DATE ? startDate : EARLIEST_DATE;
    const end = endDate < latestDate ? endDate : latestDate;

    const rates: ProviderResult['rates'] = [];
    for (
      let t = toDate(start).getTime();
      t <= toDate(end).getTime();
      t += DAY_MS
    ) {
      const d = new Date(t);
      if (isWeekday(d)) {
        rates.push({ date: toDay(d), rate });
      }
    }

    return { rates, latestDate, earliestDate: EARLIEST_DATE };
  }
}
