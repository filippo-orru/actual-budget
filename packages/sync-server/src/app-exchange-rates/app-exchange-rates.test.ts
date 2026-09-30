import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';

import { handlers as app } from './app-exchange-rates';
import { resetExchangeRatesDb } from './exchange-rates-db';
import { defaultProvider } from './service';

let tmpDir: string;
let dbPath: string;

const post = (body: any) =>
  request(app).post('/rates').set('x-actual-token', 'valid-token').send(body);

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'exchange-rates-'));
  dbPath = join(tmpDir, 'exchange-rates.sqlite');
  resetExchangeRatesDb(dbPath);
  vi.spyOn(console, 'log').mockImplementation(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExchangeRatesDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /rates', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/rates')
      .send({ base: 'AUD', quote: 'USD', dates: ['2024-03-01'] });
    expect(res.statusCode).toEqual(401);
  });

  it('creates the database file and returns one row per date', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await post({
      base: 'AUD',
      quote: 'USD',
      dates: ['2024-03-02', '2024-03-01', today, '2024-03-01'],
    });

    expect(res.statusCode).toEqual(200);
    expect(existsSync(dbPath)).toBe(true);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.provider).toBe('hardcoded');
    expect(res.body.data.rows).toEqual([
      { date: '2024-03-02', rate: null, is_final: true },
      { date: '2024-03-01', rate: 0.65, is_final: true },
      { date: today, rate: null, is_final: false },
    ]);
  });

  it('does not call the provider on an identical second request', async () => {
    const spy = vi.spyOn(defaultProvider, 'getRates');
    const body = { base: 'AUD', quote: 'USD', dates: ['2024-03-01'] };
    await post(body);
    await post(body);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null/final before the provider history', async () => {
    const res = await post({
      base: 'AUD',
      quote: 'USD',
      dates: ['1999-01-04'],
    });
    expect(res.body.data.rows).toEqual([
      { date: '1999-01-04', rate: null, is_final: true },
    ]);
  });

  it.each([
    [
      'non-canonical order',
      { base: 'USD', quote: 'AUD', dates: ['2024-03-01'] },
    ],
    ['bad base', { base: 'aud', quote: 'USD', dates: ['2024-03-01'] }],
    ['bad quote', { base: 'AUD', quote: 'US', dates: ['2024-03-01'] }],
    ['bad date format', { base: 'AUD', quote: 'USD', dates: ['03/01/2024'] }],
    ['impossible date', { base: 'AUD', quote: 'USD', dates: ['2024-02-31'] }],
    ['empty dates', { base: 'AUD', quote: 'USD', dates: [] }],
    ['missing dates', { base: 'AUD', quote: 'USD' }],
    [
      'too many dates',
      {
        base: 'AUD',
        quote: 'USD',
        dates: Array.from({ length: 20001 }, (_, i) => `2024-01-${i}`),
      },
    ],
  ])('rejects %s', async (_name, body) => {
    const res = await post(body);
    expect(res.statusCode).toEqual(400);
    expect(res.body.status).toBe('error');
    expect(res.body.reason).toBe('invalid-request');
  });

  it('rejects unsupported pairs', async () => {
    const res = await post({
      base: 'AAA',
      quote: 'USD',
      dates: ['2024-03-01'],
    });
    expect(res.statusCode).toEqual(400);
    expect(res.body).toEqual({ status: 'error', reason: 'unsupported-pair' });
  });

  it('reports provider errors', async () => {
    vi.spyOn(defaultProvider, 'getRates').mockRejectedValue(new Error('boom'));
    const res = await post({
      base: 'AUD',
      quote: 'USD',
      dates: ['2024-03-01'],
    });
    expect(res.statusCode).toEqual(502);
    expect(res.body.reason).toBe('provider-error');
  });
});
