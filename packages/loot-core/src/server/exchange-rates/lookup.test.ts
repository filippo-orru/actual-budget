import {
  canonicalPair,
  needsFetch,
  resolveRates,
  withLookback,
} from './lookup';
import type { RateRow } from './lookup';

const NOW = new Date('2024-03-06T12:00:00Z');

function row(overrides: Partial<RateRow>): RateRow {
  return {
    base: 'AUD',
    quote: 'USD',
    date: '2024-03-01',
    rate: 0.65,
    is_final: 1,
    fetched_at: NOW.toISOString(),
    ...overrides,
  };
}

describe('canonicalPair', () => {
  it('keeps alphabetical order', () => {
    expect(canonicalPair('AUD', 'USD')).toEqual({
      base: 'AUD',
      quote: 'USD',
      inverted: false,
    });
  });

  it('swaps and flags inversion otherwise', () => {
    expect(canonicalPair('USD', 'AUD')).toEqual({
      base: 'AUD',
      quote: 'USD',
      inverted: true,
    });
  });
});

describe('withLookback', () => {
  it('adds the 7 preceding days, deduped and sorted', () => {
    expect(withLookback(['2024-03-02', '2024-03-01'])).toEqual([
      '2024-02-23',
      '2024-02-24',
      '2024-02-25',
      '2024-02-26',
      '2024-02-27',
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
      '2024-03-02',
    ]);
  });

  it('crosses year boundaries', () => {
    expect(withLookback(['2024-01-02'])[0]).toBe('2023-12-26');
  });
});

describe('resolveRates', () => {
  const rows = [
    { date: '2024-03-01', rate: 0.65 },
    { date: '2024-03-02', rate: null },
    { date: '2024-03-04', rate: 0.7 },
  ];

  it('carries the latest non-null rate forward', () => {
    expect(
      resolveRates(rows, [
        '2024-03-01',
        '2024-03-03',
        '2024-03-04',
        '2024-03-09',
      ]),
    ).toEqual({
      '2024-03-01': 0.65,
      '2024-03-03': 0.65,
      '2024-03-04': 0.7,
      '2024-03-09': 0.7,
    });
  });

  it('returns null when nothing precedes the date', () => {
    expect(resolveRates(rows, ['2024-02-29'])).toEqual({ '2024-02-29': null });
  });

  it('ignores is_final', () => {
    expect(
      resolveRates([row({ date: '2024-03-01', is_final: 0 })], ['2024-03-02']),
    ).toEqual({ '2024-03-02': 0.65 });
  });
});

describe('needsFetch', () => {
  const hoursAgo = (h: number) =>
    new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();

  it('needs a fetch when the row is missing', () => {
    expect(needsFetch(undefined, NOW)).toBe(true);
  });

  it('never refetches final rows', () => {
    expect(needsFetch(row({ fetched_at: hoursAgo(1000) }), NOW)).toBe(false);
    expect(
      needsFetch(row({ rate: null, fetched_at: hoursAgo(1000) }), NOW),
    ).toBe(false);
  });

  it('refetches pending rows only after 12h', () => {
    const pending = { rate: null, is_final: 0 };
    expect(needsFetch(row({ ...pending, fetched_at: hoursAgo(11) }), NOW)).toBe(
      false,
    );
    expect(needsFetch(row({ ...pending, fetched_at: hoursAgo(13) }), NOW)).toBe(
      true,
    );
  });
});
