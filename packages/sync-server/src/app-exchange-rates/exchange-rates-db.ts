import { join, resolve } from 'node:path';

import { openDatabase } from '#db';
import type { WrappedDatabase } from '#db';
import { config } from '#load-config';

export type ExchangeRateRow = {
  base: string;
  quote: string;
  date: string;
  rate: number | null;
  is_final: number;
  fetched_at: string;
};

let db: WrappedDatabase | null = null;
let overridePath: string | null = null;

function open(): WrappedDatabase {
  if (db) {
    return db;
  }
  const path =
    overridePath ??
    join(resolve(config.get('serverFiles')), 'exchange-rates.sqlite');
  db = openDatabase(path);
  db.exec(`CREATE TABLE IF NOT EXISTS exchange_rates
    (base TEXT NOT NULL, quote TEXT NOT NULL, date TEXT NOT NULL,
     rate REAL, is_final INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL,
     PRIMARY KEY (base, quote, date))`);
  return db;
}

/** Test helper: close the DB and optionally use a different file path. */
export function resetExchangeRatesDb(path: string | null = null) {
  db?.close();
  db = null;
  overridePath = path;
}

export function getRows(
  base: string,
  quote: string,
  dates: string[],
): ExchangeRateRow[] {
  const database = open();
  const rows: ExchangeRateRow[] = [];
  // Stay below SQLite's bound-parameter limit.
  const chunkSize = 500;
  for (let i = 0; i < dates.length; i += chunkSize) {
    const chunk = dates.slice(i, i + chunkSize);
    rows.push(
      ...database.all(
        `SELECT base, quote, date, rate, is_final, fetched_at
           FROM exchange_rates
          WHERE base = ? AND quote = ? AND date IN (${chunk.map(() => '?').join(',')})`,
        [base, quote, ...chunk],
      ),
    );
  }
  return rows;
}

export function upsertRows(rows: ExchangeRateRow[]) {
  const database = open();
  database.transaction(() => {
    for (const row of rows) {
      database.mutate(
        `INSERT INTO exchange_rates (base, quote, date, rate, is_final, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(base, quote, date) DO UPDATE SET
           rate = excluded.rate,
           is_final = excluded.is_final,
           fetched_at = excluded.fetched_at`,
        [row.base, row.quote, row.date, row.rate, row.is_final, row.fetched_at],
      );
    }
  });
}
