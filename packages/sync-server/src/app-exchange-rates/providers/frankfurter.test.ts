import { describe, it, expect, beforeEach, vi } from 'vitest';

import { FrankfurterProvider } from './frankfurter';

describe('FrankfurterProvider', () => {
  let provider: FrankfurterProvider;
  let mockNow: () => Date;

  beforeEach(() => {
    // Mock the current date to 2024-03-05 (Tuesday)
    mockNow = () => new Date('2024-03-05T12:00:00Z');
    provider = new FrankfurterProvider(mockNow);

    // Mock global fetch
    global.fetch = vi.fn();
  });

  describe('supports', () => {
    it('returns true for valid 3-letter currency codes (different or same)', () => {
      expect(provider.supports('USD', 'EUR')).toBe(true);
      expect(provider.supports('GBP', 'JPY')).toBe(true);
      expect(provider.supports('EUR', 'USD')).toBe(true);
      // Same currency is supported (returns identity rate of 1.0)
      expect(provider.supports('USD', 'USD')).toBe(true);
      expect(provider.supports('EUR', 'EUR')).toBe(true);
    });

    it('returns false for invalid currency codes', () => {
      expect(provider.supports('INVALID', 'EUR')).toBe(false);
      expect(provider.supports('USD', 'XX')).toBe(false);
      expect(provider.supports('US', 'EUR')).toBe(false);
      expect(provider.supports('', 'EUR')).toBe(false);
    });
  });

  describe('getRates', () => {
    it('returns identity rate (1.0) for same-currency pairs without API call', async () => {
      const result = await provider.getRates(
        'USD',
        'USD',
        '2024-03-01',
        '2024-03-05',
      );

      // Should not have called fetch for same-currency pair
      expect(global.fetch).not.toHaveBeenCalled();

      // Should return 1.0 for all dates (5 days: Mar 1-5)
      expect(result.rates).toHaveLength(5);
      expect(result.rates[0]).toEqual({ date: '2024-03-01', rate: 1.0 });
      expect(result.rates[4]).toEqual({ date: '2024-03-05', rate: 1.0 });
      expect(result.latestDate).toBe('2024-03-05');
      expect(result.earliestDate).toBe('1999-01-04');
    });

    it('caps same-currency pair queries to today', async () => {
      const result = await provider.getRates(
        'EUR',
        'EUR',
        '2024-03-01',
        '2024-03-10',
      );

      // Should not call fetch
      expect(global.fetch).not.toHaveBeenCalled();

      // Should only return rates up to today (2024-03-05)
      const dates = result.rates.map(r => r.date);
      expect(dates.every(d => d <= '2024-03-05')).toBe(true);
      expect(result.rates.every(r => r.rate === 1.0)).toBe(true);
      expect(result.latestDate).toBe('2024-03-05');
    });

    it('fetches exchange rates for a date range using range query', async () => {
      const mockResponse = {
        ok: true,
        json: async () => [
          { date: '2024-03-01', base: 'USD', quote: 'EUR', rate: 0.92 },
          { date: '2024-03-02', base: 'USD', quote: 'EUR', rate: 0.91 },
        ],
      };

      (global.fetch as any).mockResolvedValue(mockResponse);

      const result = await provider.getRates(
        'USD',
        'EUR',
        '2024-03-01',
        '2024-03-02',
      );

      expect(result.rates).toHaveLength(2);
      expect(result.rates[0]).toEqual({ date: '2024-03-01', rate: 0.92 });
      expect(result.rates[1]).toEqual({ date: '2024-03-02', rate: 0.91 });
      expect(result.latestDate).toBe('2024-03-02');
      expect(result.earliestDate).toBe('1999-01-04');

      // Verify the URL was constructed correctly
      const callUrl = (global.fetch as any).mock.calls[0][0];
      expect(callUrl).toContain('https://api.frankfurter.dev/v2/rates');
      expect(callUrl).toContain('from=2024-03-01');
      expect(callUrl).toContain('to=2024-03-02');
      expect(callUrl).toContain('base=USD');
      expect(callUrl).toContain('quotes=EUR');
    });

    it('handles API errors gracefully by returning empty rates', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await provider.getRates(
        'USD',
        'EUR',
        '2024-03-01',
        '2024-03-02',
      );

      expect(result.rates).toHaveLength(0);
      expect(result.latestDate).toBe('2024-03-01');
      expect(result.earliestDate).toBe('1999-01-04');
    });

    it('caps query to today when endDate is in the future', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => [
          { date: '2024-03-01', base: 'USD', quote: 'EUR', rate: 0.92 },
          { date: '2024-03-05', base: 'USD', quote: 'EUR', rate: 0.9 },
        ],
      });

      // Request dates beyond today (mocked as 2024-03-05)
      await provider.getRates('USD', 'EUR', '2024-03-01', '2024-03-10');

      const callUrl = (global.fetch as any).mock.calls[0][0];
      // Should cap to today (2024-03-05) instead of the requested 2024-03-10
      expect(callUrl).toContain('to=2024-03-05');
    });

    it('filters response to only include the requested quote currency', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => [
          { date: '2024-03-01', base: 'USD', quote: 'EUR', rate: 0.92 },
          { date: '2024-03-01', base: 'USD', quote: 'GBP', rate: 0.79 },
          { date: '2024-03-01', base: 'USD', quote: 'USD', rate: 1.0 },
          { date: '2024-03-02', base: 'USD', quote: 'EUR', rate: 0.91 },
        ],
      });

      const result = await provider.getRates(
        'USD',
        'EUR',
        '2024-03-01',
        '2024-03-02',
      );

      // Should only include EUR rates (filters out GBP and USD=USD pairs)
      expect(result.rates).toHaveLength(2);
      expect(result.rates).toEqual([
        { date: '2024-03-01', rate: 0.92 },
        { date: '2024-03-02', rate: 0.91 },
      ]);
    });

    it('handles empty API response by using startDate as latestDate', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      const result = await provider.getRates(
        'USD',
        'EUR',
        '2024-03-01',
        '2024-03-02',
      );

      expect(result.rates).toHaveLength(0);
      expect(result.latestDate).toBe('2024-03-01');
      expect(result.earliestDate).toBe('1999-01-04');
    });

    it('constructs correct API URL with proper parameters', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => [],
      });

      // Using dates in the past (before today: 2024-03-05)
      await provider.getRates('GBP', 'JPY', '2024-01-15', '2024-01-31');

      const callUrl = (global.fetch as any).mock.calls[0][0];
      expect(callUrl).toContain('https://api.frankfurter.dev/v2/rates');
      expect(callUrl).toContain('from=2024-01-15');
      expect(callUrl).toContain('to=2024-01-31');
      expect(callUrl).toContain('base=GBP');
      expect(callUrl).toContain('quotes=JPY');
    });
  });
});
