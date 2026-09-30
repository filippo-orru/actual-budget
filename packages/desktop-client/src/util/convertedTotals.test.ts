import { aggregateConvertedTotal } from './convertedTotals';

describe('aggregateConvertedTotal', () => {
  const accounts = [
    { id: 'usd', currency: 'USD' },
    { id: 'eur', currency: 'EUR' },
    { id: 'jpy', currency: 'JPY' },
  ];

  it('keeps global currency accounts as they are', () => {
    const result = aggregateConvertedTotal({
      accounts: [accounts[0]],
      nativeByAccount: { usd: 5000 },
      globalCurrency: 'USD',
      rates: {},
    });

    expect(result.total).toBe(5000);
    expect(result.missingPairs).toEqual([]);
  });

  it('converts foreign account totals and sums them', () => {
    const result = aggregateConvertedTotal({
      accounts,
      nativeByAccount: { usd: 1000, eur: 10000, jpy: 100000 },
      globalCurrency: 'USD',
      rates: { EUR: 1.1, JPY: 0.0065 },
    });

    // EUR: 100.00 * 1.1 = 110.00 -> 11000, JPY: 100000 * 0.0065 = 650.00 -> 65000
    expect(result.perAccount.eur).toEqual({
      native: 10000,
      converted: 11000,
      rate: 1.1,
    });
    expect(result.perAccount.jpy.converted).toBe(65000);
    expect(result.total).toBe(1000 + 11000 + 65000);
  });

  it('rounds once per account total, not per transaction', () => {
    // 3 x 0.05 EUR converted at 1.1 would round to 0.06 each (0.18 total);
    // converting the 0.15 total gives 0.165 -> 0.17
    const result = aggregateConvertedTotal({
      accounts: [accounts[1]],
      nativeByAccount: { eur: 15 },
      globalCurrency: 'USD',
      rates: { EUR: 1.1 },
    });

    expect(result.total).toBe(17);
  });

  it('rounds negative totals symmetrically', () => {
    const result = aggregateConvertedTotal({
      accounts: [accounts[1]],
      nativeByAccount: { eur: -15 },
      globalCurrency: 'USD',
      rates: { EUR: 1.1 },
    });

    expect(result.total).toBe(-17);
  });

  it('treats accounts without transactions as zero', () => {
    const result = aggregateConvertedTotal({
      accounts,
      nativeByAccount: {},
      globalCurrency: 'USD',
      rates: { EUR: 1.1, JPY: 0.0065 },
    });

    expect(result.total).toBe(0);
  });

  it('propagates an unavailable rate as a null total', () => {
    const result = aggregateConvertedTotal({
      accounts,
      nativeByAccount: { usd: 1000, eur: 10000, jpy: 100000 },
      globalCurrency: 'USD',
      rates: { EUR: null, JPY: 0.0065 },
    });

    expect(result.total).toBeNull();
    expect(result.missingPairs).toEqual(['EUR → USD']);
    expect(result.perAccount.eur.converted).toBeNull();
    expect(result.perAccount.jpy.converted).toBe(65000);
  });

  it('treats rates that are not loaded yet as unavailable', () => {
    const result = aggregateConvertedTotal({
      accounts: [accounts[1]],
      nativeByAccount: { eur: 100 },
      globalCurrency: 'USD',
      rates: {},
    });

    expect(result.total).toBeNull();
  });
});
