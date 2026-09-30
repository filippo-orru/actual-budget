import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetExchangeRatesDb } from './exchange-rates-db';
import { HardcodedProvider } from './providers/hardcoded';
import { getRatesForDates } from './service';

// 2024-03-01 is a Friday, 2024-03-02 a Saturday, 2024-03-03 a Sunday.
const NOW = new Date('2024-03-06T10:00:00Z'); // Wednesday
const HOUR = 60 * 60 * 1000;

let tmpDir: string;

function setup(now = NOW) {
  const provider = new HardcodedProvider(() => now);
  const spy = vi.spyOn(provider, 'getRates');
  return { provider, spy };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'exchange-rates-'));
  resetExchangeRatesDb(join(tmpDir, 'exchange-rates.sqlite'));
});

afterEach(() => {
  resetExchangeRatesDb(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getRatesForDates', () => {
  it('returns one row per date with the right final/pending state', async () => {
    const { provider } = setup();
    const dates = ['2024-03-02', '2024-03-01', '2024-03-06'];
    const rows = await getRatesForDates('AUD', 'USD', dates, {
      provider,
      now: () => NOW,
    });

    expect(rows.map(r => r.date)).toEqual(dates);
    expect(rows[1]).toMatchObject({ rate: 0.65, is_final: 1 });
    expect(rows[0]).toMatchObject({ rate: null, is_final: 1 });
    expect(rows[2]).toMatchObject({ rate: null, is_final: 0 });
  });

  it('marks dates before the provider history as final null', async () => {
    const { provider } = setup();
    const rows = await getRatesForDates('AUD', 'USD', ['1999-12-31'], {
      provider,
      now: () => NOW,
    });
    expect(rows[0]).toMatchObject({ rate: null, is_final: 1 });
  });

  it('does not call the provider again for cached rows', async () => {
    const { provider, spy } = setup();
    const dates = ['2024-03-01', '2024-03-02', '2024-03-06'];
    const opts = { provider, now: () => NOW };
    await getRatesForDates('AUD', 'USD', dates, opts);
    await getRatesForDates('AUD', 'USD', dates, opts);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refetches pending rows only once older than 12h', async () => {
    const { provider, spy } = setup();
    const dates = ['2024-03-06'];
    await getRatesForDates('AUD', 'USD', dates, { provider, now: () => NOW });
    expect(spy).toHaveBeenCalledTimes(1);

    await getRatesForDates('AUD', 'USD', dates, {
      provider,
      now: () => new Date(NOW.getTime() + 11 * HOUR),
    });
    expect(spy).toHaveBeenCalledTimes(1);

    await getRatesForDates('AUD', 'USD', dates, {
      provider,
      now: () => new Date(NOW.getTime() + 13 * HOUR),
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('finalises a pending date once the provider publishes it', async () => {
    const { provider } = setup();
    const dates = ['2024-03-06'];
    await getRatesForDates('AUD', 'USD', dates, { provider, now: () => NOW });

    const later = new Date('2024-03-08T10:00:00Z');
    const rows = await getRatesForDates('AUD', 'USD', dates, {
      provider: new HardcodedProvider(() => later),
      now: () => later,
    });
    expect(rows[0]).toMatchObject({ rate: 0.65, is_final: 1 });
  });

  it('makes a single provider call for concurrent identical requests', async () => {
    const { provider, spy } = setup();
    const dates = ['2024-03-01', '2024-03-02'];
    const opts = { provider, now: () => NOW };
    await Promise.all([
      getRatesForDates('AUD', 'USD', dates, opts),
      getRatesForDates('AUD', 'USD', dates, opts),
      getRatesForDates('AUD', 'USD', dates, opts),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
