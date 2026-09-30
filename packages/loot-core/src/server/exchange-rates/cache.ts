import * as db from '#server/db';

import type { RateRow } from './lookup';

// This table is local-only: it must never be written with db.insert/db.update,
// which would create CRDT messages.

export function readRows(
  base: string,
  quote: string,
  dates: string[],
): RateRow[] {
  const rows: RateRow[] = [];
  const chunkSize = 500;
  for (let i = 0; i < dates.length; i += chunkSize) {
    const chunk = dates.slice(i, i + chunkSize);
    rows.push(
      ...db.runQuery<RateRow>(
        `SELECT base, quote, date, rate, is_final, fetched_at
           FROM exchange_rates
          WHERE base = ? AND quote = ? AND date IN (${chunk.map(() => '?').join(',')})`,
        [base, quote, ...chunk],
        true,
      ),
    );
  }
  return rows;
}

export function writeRows(rows: RateRow[]): void {
  for (const row of rows) {
    db.runQuery(
      `INSERT INTO exchange_rates (base, quote, date, rate, is_final, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(base, quote, date) DO UPDATE SET
         rate = excluded.rate,
         is_final = excluded.is_final,
         fetched_at = excluded.fetched_at`,
      [row.base, row.quote, row.date, row.rate, row.is_final, row.fetched_at],
    );
  }
}
