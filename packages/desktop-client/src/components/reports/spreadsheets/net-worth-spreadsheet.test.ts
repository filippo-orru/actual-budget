import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import { enUS } from 'date-fns/locale';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpreadsheet } from './net-worth-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type SpreadsheetData = Parameters<
  Parameters<ReturnType<typeof createSpreadsheet>>[1]
>[0];

type LinkedTransfer = {
  id: string;
  account: string;
  amount: number;
  date: string;
  transfer_id: string;
};

type AccountQueryResult = number | Array<{ date: string; amount: number }>;

const accounts = [
  createAccount('checking', 'Checking'),
  createAccount('savings', 'Savings'),
] satisfies AccountEntity[];

function createAccount(
  id: string,
  name: string,
  currency: string | null = null,
): AccountEntity {
  return {
    id,
    name,
    offbudget: 0,
    closed: 0,
    sort_order: 0,
    last_reconciled: null,
    tombstone: 0,
    account_group_id: null,
    currency,
    account_id: null,
    bank: null,
    bankName: null,
    bankId: null,
    mask: null,
    official_name: null,
    balance_current: null,
    balance_available: null,
    balance_limit: null,
    account_sync_source: null,
    last_sync: null,
    bank_sync_status: null,
  };
}

async function runReport({
  accounts,
  accountQueryResults,
  linkedTransfers = [],
  start = '2026-07',
  end = '2026-08',
  interval = 'Monthly',
  earliestTransactionDate = '2026-07-01',
  globalCurrency,
  rateAt,
  requestedRates = [],
}: {
  accounts: AccountEntity[];
  accountQueryResults: AccountQueryResult[];
  linkedTransfers?: LinkedTransfer[];
  start?: string;
  end?: string;
  interval?: string;
  earliestTransactionDate?: string;
  globalCurrency?: string;
  /** Mocked exchange rate for a currency at a date; null = unavailable. */
  rateAt?: (currency: string, date: string) => number | null;
  /** Collects the exchange-rates-get requests. */
  requestedRates?: Array<{ from: string; to: string; dates: string[] }>;
}) {
  const remainingAccountResults = [...accountQueryResults];

  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    'get-earliest-transaction': async () => ({
      date: earliestTransactionDate,
    }),
    'exchange-rates-get': async ({ from, to, dates }) => {
      requestedRates.push({ from, to, dates });
      const rates = Object.fromEntries(
        dates.map(date => [date, rateAt ? rateAt(from, date) : null]),
      );
      return {
        rates,
        isComplete: Object.values(rates).every(rate => rate != null),
        offline: false,
      };
    },
    query: async query => {
      if (query.selectExpressions.includes('transfer_id')) {
        const transferFilter = query.filterExpressions.find(
          expression => 'transfer_id' in expression,
        );
        const accountIds = getOneOfValues(transferFilter?.account);
        const transactionIds = getOneOfValues(transferFilter?.id);
        const endDate = getUpperBound(transferFilter?.date);

        return {
          data: linkedTransfers.filter(
            leg =>
              (accountIds.length === 0 || accountIds.includes(leg.account)) &&
              (transactionIds.length === 0 ||
                transactionIds.includes(leg.id)) &&
              (!endDate || leg.date <= endDate),
          ),
          dependencies: [],
        };
      }

      const data = remainingAccountResults.shift();
      if (data === undefined) {
        throw new Error('Unexpected account query');
      }
      return { data, dependencies: [] };
    },
  });

  let report: SpreadsheetData | undefined;
  const spreadsheet = createSpreadsheet(
    start,
    end,
    accounts,
    [],
    'and',
    enUS,
    interval,
    '0',
    value => String(value),
    undefined,
    globalCurrency,
  );

  // The net worth factory does not use its spreadsheet dependency.
  await spreadsheet(undefined as never, data => {
    report = data;
  });

  if (!report) {
    throw new Error('Spreadsheet did not produce report data');
  }
  return report;
}

function getOneOfValues(value: unknown) {
  if (
    typeof value === 'object' &&
    value !== null &&
    '$oneof' in value &&
    Array.isArray(value.$oneof)
  ) {
    return value.$oneof.filter(item => typeof item === 'string');
  }
  return [];
}

function getUpperBound(value: unknown) {
  if (
    typeof value === 'object' &&
    value !== null &&
    '$lte' in value &&
    typeof value.$lte === 'string'
  ) {
    return value.$lte;
  }
  return null;
}

afterEach(async () => {
  await clearServer();
});

describe('net worth transfers', () => {
  it('keeps a linked transfer neutral when its two legs cross months', async () => {
    const report = await runReport({
      accounts,
      accountQueryResults: [
        100_000,
        [{ date: '2026-07', amount: -10_000 }],
        0,
        [{ date: '2026-08', amount: 10_000 }],
      ],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-07-31',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-08-01',
          transfer_id: 'checking-transfer',
        },
      ],
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      100_000, 100_000,
    ]);
  });

  it('preserves a real expense as a net worth loss', async () => {
    const report = await runReport({
      accounts: [accounts[0]],
      accountQueryResults: [100_000, [{ date: '2026-07', amount: -10_000 }]],
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      90_000, 90_000,
    ]);
  });

  it('preserves a transfer out of the selected account set as a loss', async () => {
    const report = await runReport({
      accounts: [accounts[0]],
      accountQueryResults: [100_000, [{ date: '2026-07', amount: -10_000 }]],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-07-31',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-08-01',
          transfer_id: 'checking-transfer',
        },
      ],
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      90_000, 90_000,
    ]);
  });

  it('keeps funds in the source account until a later counterpart arrives', async () => {
    const report = await runReport({
      accounts,
      accountQueryResults: [
        100_000,
        [{ date: '2026-08', amount: -10_000 }],
        0,
        [],
      ],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-08-31',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-09-01',
          transfer_id: 'checking-transfer',
        },
      ],
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      100_000, 100_000,
    ]);
    expect(report.graphData.data.at(-1)).toMatchObject({ checking: 100_000 });
  });

  it('keeps a transfer neutral when it spans the entire report range', async () => {
    const report = await runReport({
      accounts,
      accountQueryResults: [90_000, [], 0, []],
      linkedTransfers: [
        {
          id: 'checking-transfer',
          account: 'checking',
          amount: -10_000,
          date: '2026-06-30',
          transfer_id: 'savings-transfer',
        },
        {
          id: 'savings-transfer',
          account: 'savings',
          amount: 10_000,
          date: '2026-09-01',
          transfer_id: 'checking-transfer',
        },
      ],
      start: '2026-08',
      end: '2026-08',
      earliestTransactionDate: '2026-06-30',
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      100_000, 100_000,
    ]);
  });

  it.each([
    {
      interval: 'Daily',
      start: '2016-07',
      end: '2016-07',
      earliestTransactionDate: '2016-07-30',
      earlierDate: '2016-07-30',
      laterDate: '2016-07-31',
      earlierBalanceDate: '2016-07-30',
      laterBalanceDate: '2016-07-31',
    },
    {
      interval: 'Weekly',
      start: '2016-07',
      end: '2016-07',
      earliestTransactionDate: '2016-07-30',
      earlierDate: '2016-07-30',
      laterDate: '2016-07-31',
      earlierBalanceDate: '2016-07-30',
      laterBalanceDate: '2016-07-31',
    },
    {
      interval: 'Yearly',
      start: '2016-01',
      end: '2017-01',
      earliestTransactionDate: '2016-12-31',
      earlierDate: '2016-12-31',
      laterDate: '2017-01-01',
      earlierBalanceDate: '2016',
      laterBalanceDate: '2017',
    },
  ])(
    'keeps a linked transfer neutral across $interval intervals',
    async ({
      interval,
      start,
      end,
      earliestTransactionDate,
      earlierDate,
      laterDate,
      earlierBalanceDate,
      laterBalanceDate,
    }) => {
      const report = await runReport({
        accounts,
        accountQueryResults: [
          100_000,
          [{ date: earlierBalanceDate, amount: -10_000 }],
          0,
          [{ date: laterBalanceDate, amount: 10_000 }],
        ],
        linkedTransfers: [
          {
            id: 'checking-transfer',
            account: 'checking',
            amount: -10_000,
            date: earlierDate,
            transfer_id: 'savings-transfer',
          },
          {
            id: 'savings-transfer',
            account: 'savings',
            amount: 10_000,
            date: laterDate,
            transfer_id: 'checking-transfer',
          },
        ],
        start,
        end,
        interval,
        earliestTransactionDate,
      });

      const totals = report.graphData.data.map(point => point.y);
      expect(totals).toEqual(totals.map(() => 100_000));
    },
  );
});

describe('net worth multi-currency conversion', () => {
  const eurAccount = createAccount('eur', 'Euro savings', 'EUR');
  const monthlyRates: Record<string, number> = {
    '2026-06-30': 1,
    '2026-07-31': 1.1,
    '2026-08-31': 1.2,
  };

  it('converts a constant balance at each interval end date', async () => {
    const report = await runReport({
      accounts: [eurAccount],
      // €1,000 before the range and no transactions in it
      accountQueryResults: [100_000, []],
      globalCurrency: 'USD',
      rateAt: (_currency, date) => monthlyRates[date] ?? null,
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      110_000, 120_000,
    ]);
    // The net worth changes by exactly the converted difference
    expect(report.netWorth).toBe(120_000);
    expect(report.totalChange).toBe(10_000);
    expect(report.missingPairs).toEqual([]);
  });

  it('converts the per-account balances map too', async () => {
    const report = await runReport({
      accounts: [eurAccount],
      accountQueryResults: [100_000, []],
      globalCurrency: 'USD',
      rateAt: (_currency, date) => monthlyRates[date] ?? null,
    });

    expect(
      report.graphData.data.map(
        point => (point as Record<string, unknown>).eur,
      ),
    ).toEqual([110_000, 120_000]);
  });

  it('sums converted foreign accounts with global currency accounts', async () => {
    const report = await runReport({
      accounts: [accounts[0], eurAccount],
      accountQueryResults: [50_000, [], 100_000, []],
      globalCurrency: 'USD',
      rateAt: (_currency, date) => monthlyRates[date] ?? null,
    });

    expect(report.graphData.data.map(point => point.y)).toEqual([
      160_000, 170_000,
    ]);
  });

  it('converts a 0-decimal currency (JPY) into USD', async () => {
    const report = await runReport({
      accounts: [createAccount('jpy', 'Yen', 'JPY')],
      // ¥100,000 (JPY has no minor units)
      accountQueryResults: [100_000, []],
      globalCurrency: 'USD',
      rateAt: () => 0.0065,
    });

    // ¥100,000 * 0.0065 = $650.00 = 65,000 cents
    expect(report.graphData.data.map(point => point.y)).toEqual([
      65_000, 65_000,
    ]);
  });

  it('marks intervals with a missing rate and leaves the others alone', async () => {
    const report = await runReport({
      accounts: [eurAccount],
      accountQueryResults: [100_000, []],
      globalCurrency: 'USD',
      rateAt: (_currency, date) =>
        date === '2026-08-31' ? null : (monthlyRates[date] ?? null),
    });

    const [july, august] = report.graphData.data;
    expect(july.y).toBe(110_000);
    expect(july.hasMissingRate).toBe(false);
    expect(august.y).toBeNull();
    expect(august.hasMissingRate).toBe(true);
    expect(august.networth).toBe('\u2014');
    expect(report.missingPairs).toEqual(['EUR \u2192 USD']);
    // The summary depends on the missing interval
    expect(report.netWorth).toBeNull();
    expect(report.totalChange).toBeNull();
    expect(report.lowestNetWorth).toBe(110_000);
    expect(report.highestNetWorth).toBe(110_000);
  });

  it('does not produce a total when the starting rate is missing', async () => {
    const report = await runReport({
      accounts: [eurAccount],
      accountQueryResults: [100_000, []],
      globalCurrency: 'USD',
      rateAt: (_currency, date) =>
        date === '2026-06-30' ? null : (monthlyRates[date] ?? null),
    });

    // Only the change of the first interval depends on the starting rate
    expect(report.graphData.data.map(point => point.y)).toEqual([
      110_000, 120_000,
    ]);
    expect(report.graphData.data[0].change).toBe('\u2014');
    expect(report.graphData.data[1].change).toBe('10000');
  });

  it('requests the rates once per currency at the monthly end dates', async () => {
    const requestedRates: Array<{ from: string; to: string; dates: string[] }> =
      [];
    await runReport({
      accounts: [eurAccount, createAccount('eur2', 'Euro 2', 'EUR')],
      accountQueryResults: [0, [], 0, []],
      globalCurrency: 'USD',
      rateAt: () => 1,
      requestedRates,
    });

    expect(requestedRates).toEqual([
      {
        from: 'EUR',
        to: 'USD',
        dates: ['2026-06-30', '2026-07-31', '2026-08-31'],
      },
    ]);
  });

  // Note: "today" is fixed to 2017-01-01 in tests, so daily and weekly
  // ranges in 2016 are not clamped.
  it('requests the rates at the end of each day', async () => {
    const requestedRates: Array<{ from: string; to: string; dates: string[] }> =
      [];
    await runReport({
      accounts: [eurAccount],
      accountQueryResults: [0, []],
      globalCurrency: 'USD',
      rateAt: () => 1,
      requestedRates,
      start: '2016-01',
      end: '2016-01',
      interval: 'Daily',
      earliestTransactionDate: '2016-01-01',
    });

    const { dates } = requestedRates[0];
    expect(dates[0]).toBe('2015-12-31');
    expect(dates[1]).toBe('2016-01-01');
    expect(dates.at(-1)).toBe('2016-01-31');
    expect(dates).toHaveLength(32);
  });

  it('requests the rates at the end of each week (week start + 6 days)', async () => {
    const requestedRates: Array<{ from: string; to: string; dates: string[] }> =
      [];
    await runReport({
      accounts: [eurAccount],
      accountQueryResults: [0, []],
      globalCurrency: 'USD',
      rateAt: () => 1,
      requestedRates,
      start: '2016-01',
      end: '2016-01',
      interval: 'Weekly',
      earliestTransactionDate: '2016-01-01',
    });

    // Weeks start on Sunday: the first one begins on 2015-12-27
    expect(requestedRates[0].dates).toEqual([
      '2015-12-26',
      '2016-01-02',
      '2016-01-09',
      '2016-01-16',
      '2016-01-23',
      '2016-01-30',
      '2016-02-06',
    ]);
  });

  it('requests the rates at the end of each year (December 31st)', async () => {
    const requestedRates: Array<{ from: string; to: string; dates: string[] }> =
      [];
    await runReport({
      accounts: [eurAccount],
      accountQueryResults: [0, []],
      globalCurrency: 'USD',
      rateAt: () => 1,
      requestedRates,
      start: '2025-01',
      end: '2026-01',
      interval: 'Yearly',
      earliestTransactionDate: '2025-01-01',
    });

    expect(requestedRates[0].dates).toEqual([
      '2024-12-31',
      '2025-12-31',
      '2026-12-31',
    ]);
  });

  it('does not request rates without a global currency (multiCurrency off)', async () => {
    const requestedRates: Array<{ from: string; to: string; dates: string[] }> =
      [];
    const report = await runReport({
      accounts: [eurAccount],
      accountQueryResults: [100_000, []],
      requestedRates,
    });

    expect(requestedRates).toEqual([]);
    expect(report.graphData.data.map(point => point.y)).toEqual([
      100_000, 100_000,
    ]);
    expect(report.missingPairs).toEqual([]);
  });
});
