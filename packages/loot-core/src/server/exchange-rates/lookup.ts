export type RateRow = {
  base: string;
  quote: string;
  date: string;
  rate: number | null;
  is_final: number;
  fetched_at: string;
};

export const PENDING_TTL_MS = 12 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function canonicalPair(
  from: string,
  to: string,
): { base: string; quote: string; inverted: boolean } {
  return from < to
    ? { base: from, quote: to, inverted: false }
    : { base: to, quote: from, inverted: true };
}

function shiftDay(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Deduped, sorted union of each date and its `days` preceding days. */
export function withLookback(dates: string[], days = 7): string[] {
  const all = new Set<string>();
  for (const date of dates) {
    for (let i = 0; i <= days; i++) {
      all.add(shiftDay(date, -i));
    }
  }
  return [...all].sort();
}

/**
 * Carry-forward: the rate for date D is the rate of the most recent row with a
 * non-null rate and date <= D. `is_final` is ignored here.
 */
export function resolveRates(
  rows: Array<Pick<RateRow, 'date' | 'rate'>>,
  requestedDates: string[],
): Record<string, number | null> {
  const published = rows
    .filter(row => row.rate != null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const result: Record<string, number | null> = {};
  for (const date of requestedDates) {
    let found: number | null = null;
    for (const row of published) {
      if (row.date > date) {
        break;
      }
      found = row.rate;
    }
    result[date] = found;
  }
  return result;
}

/** Missing, or pending (is_final = 0) and fetched more than 12h ago. */
export function needsFetch(row: RateRow | undefined, now: Date): boolean {
  if (!row) {
    return true;
  }
  if (row.is_final === 1) {
    return false;
  }
  return now.getTime() - new Date(row.fetched_at).getTime() > PENDING_TTL_MS;
}
