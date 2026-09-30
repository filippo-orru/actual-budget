BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS exchange_rates
  (base TEXT NOT NULL, quote TEXT NOT NULL, date TEXT NOT NULL,
   rate REAL, is_final INTEGER NOT NULL DEFAULT 0, fetched_at TEXT NOT NULL,
   PRIMARY KEY (base, quote, date));

COMMIT;
