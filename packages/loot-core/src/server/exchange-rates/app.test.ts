import * as asyncStorage from '#platform/server/asyncStorage';
import * as db from '#server/db';
import { post } from '#server/post';
import { getServer, setServer } from '#server/server-config';

import { app } from './app';

vi.mock('#server/post', () => ({ post: vi.fn() }));

// 2024-03-01 Fri, 02 Sat, 03 Sun, 04 Mon.
const FRI = '2024-03-01';
const SUN = '2024-03-03';
const MON = '2024-03-04';

type Body = { base: string; quote: string; dates: string[] };

// Mimics the sync server: a fixed AUD/USD rate of 0.65 on weekdays on or after
// 2000-01-03, null/final on other dates and null/pending after 2030.
function fakeServer(rate = 0.65) {
  return vi.mocked(post).mockImplementation(async (_url, body) => {
    const { dates } = body as Body;
    return {
      rows: dates.map(date => {
        const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (date > '2030-01-01') {
          return { date, rate: null, is_final: false };
        }
        const published = date >= '2000-01-03' && dow >= 1 && dow <= 5;
        return { date, rate: published ? rate : null, is_final: true };
      }),
      provider: 'fake',
    };
  });
}

const get = (args: { from: string; to: string; dates: string[] }) =>
  app.handlers['exchange-rates-get'](args);

let serverConfig: ReturnType<typeof getServer>;

beforeEach(async () => {
  await global.emptyDatabase()();
  vi.mocked(asyncStorage.getItem).mockResolvedValue('token');
  vi.mocked(post).mockReset();
});

afterEach(() => {
  if (serverConfig) {
    setServer(serverConfig.BASE_SERVER);
  }
});

describe('exchange-rates-get', () => {
  it('returns 1 without any lookup for identical currencies', async () => {
    const spy = fakeServer();
    const res = await get({ from: 'USD', to: 'USD', dates: [FRI] });
    expect(res).toEqual({
      rates: { [FRI]: 1 },
      isComplete: true,
      offline: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('requests the canonical pair and inverts when needed', async () => {
    const spy = fakeServer(0.65);
    const res = await get({ from: 'USD', to: 'AUD', dates: [FRI] });

    const [url, body] = spy.mock.calls[0];
    expect(String(url)).toMatch(/\/exchange-rates\/rates$/);
    expect(body).toMatchObject({ base: 'AUD', quote: 'USD' });
    expect(res.rates[FRI]).toBeCloseTo(1 / 0.65);
    expect(res.isComplete).toBe(true);
    expect(res.offline).toBe(false);

    const forward = await get({ from: 'AUD', to: 'USD', dates: [FRI] });
    expect(forward.rates[FRI]).toBe(0.65);
  });

  it('resolves a Sunday to the preceding Friday', async () => {
    fakeServer();
    const res = await get({ from: 'AUD', to: 'USD', dates: [SUN, MON] });
    expect(res.rates).toEqual({ [SUN]: 0.65, [MON]: 0.65 });
  });

  it('returns null and incomplete before the provider history', async () => {
    fakeServer();
    const res = await get({ from: 'AUD', to: 'USD', dates: ['1999-06-01'] });
    expect(res.rates['1999-06-01']).toBeNull();
    expect(res.isComplete).toBe(false);
  });

  it('makes no HTTP request when repeating the same call', async () => {
    const spy = fakeServer();
    const args = { from: 'AUD', to: 'USD', dates: [FRI, SUN] };
    await get(args);
    expect(spy).toHaveBeenCalledTimes(1);
    await get(args);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refetches pending rows only when older than 12h', async () => {
    const spy = fakeServer();
    const args = { from: 'AUD', to: 'USD', dates: ['2031-01-06'] };
    await get(args);
    const calls = spy.mock.calls.length;

    // Fresh pending rows: no refetch.
    await get(args);
    expect(spy).toHaveBeenCalledTimes(calls);

    // Age every cached row by 13h.
    // (Date.now is frozen in tests, `new Date()` still uses the real clock.)
    const old = new Date(new Date().getTime() - 13 * 60 * 60 * 1000);
    db.runQuery('UPDATE exchange_rates SET fetched_at = ?', [
      old.toISOString(),
    ]);
    await get(args);
    expect(spy.mock.calls.length).toBeGreaterThan(calls);
  });

  it('does not create CRDT messages when writing rates', async () => {
    fakeServer();
    await get({ from: 'AUD', to: 'USD', dates: [FRI] });

    const cached = db.runQuery<{ n: number }>(
      'SELECT COUNT(*) AS n FROM exchange_rates',
      [],
      true,
    );
    expect(cached[0].n).toBeGreaterThan(0);
    const messages = db.runQuery<{ n: number }>(
      'SELECT COUNT(*) AS n FROM messages_crdt',
      [],
      true,
    );
    expect(messages[0].n).toBe(0);
  });

  it('resolves offline when the server is unreachable, keeping cached data', async () => {
    fakeServer();
    await get({ from: 'AUD', to: 'USD', dates: [FRI] });

    vi.mocked(post).mockRejectedValue(new Error('network-failure'));
    const res = await get({
      from: 'AUD',
      to: 'USD',
      dates: [FRI, '2024-06-03'],
    });
    expect(res.offline).toBe(true);
    expect(res.rates[FRI]).toBe(0.65);
    // Carry-forward from the cached Friday.
    expect(res.rates['2024-06-03']).toBe(0.65);
  });

  it('resolves offline with nulls when nothing is cached', async () => {
    vi.mocked(post).mockRejectedValue(new Error('network-failure'));
    const res = await get({ from: 'AUD', to: 'USD', dates: [FRI] });
    expect(res).toEqual({
      rates: { [FRI]: null },
      isComplete: false,
      offline: true,
    });
  });

  it('resolves offline when there is no server or user token', async () => {
    const spy = fakeServer();

    vi.mocked(asyncStorage.getItem).mockResolvedValue(undefined);
    let res = await get({ from: 'AUD', to: 'USD', dates: [FRI] });
    expect(res.offline).toBe(true);

    vi.mocked(asyncStorage.getItem).mockResolvedValue('token');
    serverConfig = getServer();
    // setServer(null) clears the config at runtime
    setServer(null);
    res = await get({ from: 'AUD', to: 'USD', dates: [FRI] });
    expect(res.offline).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('shares one request between concurrent calls', async () => {
    const spy = fakeServer();
    const args = { from: 'AUD', to: 'USD', dates: [FRI] };
    await Promise.all([get(args), get(args), get(args)]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
