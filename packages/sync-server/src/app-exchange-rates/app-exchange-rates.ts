import express from 'express';

import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';

import { defaultProvider, getRatesForDates } from './service';

const MAX_DATES = 20000;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    return false;
  }
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const app = express();
export { app as handlers };
app.use(express.json({ limit: '2mb' }));
app.use(requestLoggerMiddleware);
app.use(validateSessionMiddleware);

app.post('/rates', async (req, res) => {
  const { base, quote, dates } = req.body ?? {};

  const invalid = (details: string) =>
    res
      .status(400)
      .send({ status: 'error', reason: 'invalid-request', details });

  if (typeof base !== 'string' || !CURRENCY_RE.test(base)) {
    return invalid('invalid-base');
  }
  if (typeof quote !== 'string' || !CURRENCY_RE.test(quote)) {
    return invalid('invalid-quote');
  }
  if (base !== quote && base >= quote) {
    return invalid('non-canonical-pair');
  }
  if (!Array.isArray(dates) || dates.length === 0) {
    return invalid('invalid-dates');
  }
  if (dates.length > MAX_DATES) {
    return invalid('too-many-dates');
  }
  if (!dates.every(isValidDate)) {
    return invalid('invalid-dates');
  }
  if (!defaultProvider.supports(base, quote)) {
    res.status(400).send({ status: 'error', reason: 'unsupported-pair' });
    return;
  }

  const uniqueDates = [...new Set<string>(dates)];

  try {
    const rows = await getRatesForDates(base, quote, uniqueDates);
    res.send({
      status: 'ok',
      data: {
        rows: rows.map(row => ({
          date: row.date,
          rate: row.rate,
          is_final: row.is_final === 1,
        })),
        provider: defaultProvider.name,
      },
    });
  } catch (error) {
    console.log('Exchange rate provider error', error);
    res.status(502).send({
      status: 'error',
      reason: 'provider-error',
      details: error instanceof Error ? error.message : undefined,
    });
  }
});
