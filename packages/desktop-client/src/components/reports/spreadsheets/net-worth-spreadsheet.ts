import { send } from '@actual-app/core/platform/client/connection';
import { convertAmount } from '@actual-app/core/server/exchange-rates/convert';
import { getDecimalPlaces } from '@actual-app/core/shared/currencies';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type {
  AccountEntity,
  RuleConditionEntity,
  TransactionEntity,
} from '@actual-app/core/types/models';
import * as d from 'date-fns';
import type { Locale } from 'date-fns';
import { keyBy } from 'es-toolkit';

import { getIntervalFormat } from '#components/reports/ReportOptions';
import type { FormatType } from '#hooks/useFormat';
import type { useSpreadsheet } from '#hooks/useSpreadsheet';
import { aqlQuery } from '#queries/aqlQuery';

type Balance = {
  date: string;
  amount: number;
};

type AccountBalanceData = {
  id: string;
  name: string;
  balances: Record<string, Balance>;
  starting: number;
};

type TransferLeg = Pick<
  TransactionEntity,
  'id' | 'account' | 'amount' | 'date'
> & {
  transfer_id: string;
};

type IntervalRange = {
  startDate: string;
  endDate: string;
  interval: string;
  firstDayOfWeekIdx: string;
};

export type NetWorthConversion = {
  globalCurrency: string;
  /** Currency of each foreign account (accounts in the global currency are absent). */
  currencyByAccount: Record<string, string>;
  /**
   * Exchange rate into the global currency at the end of an interval.
   * `index` -1 is the starting balance (the day before `startDate`).
   * Null when unavailable.
   */
  rateFor: (accountId: string, index: number) => number | null;
};

export function getIntervals(
  startDate: string,
  endDate: string,
  interval: string,
  firstDayOfWeekIdx: string,
) {
  return interval === 'Weekly'
    ? monthUtils.weekRangeInclusive(startDate, endDate, firstDayOfWeekIdx)
    : interval === 'Daily'
      ? monthUtils.dayRangeInclusive(startDate, endDate)
      : interval === 'Yearly'
        ? monthUtils.yearRangeInclusive(startDate, endDate)
        : monthUtils.rangeInclusive(
            monthUtils.getMonth(startDate),
            monthUtils.getMonth(endDate),
          );
}

/** The last day covered by an interval item (as returned by `getIntervals`). */
export function getIntervalEndDate(intervalItem: string, interval: string) {
  if (interval === 'Daily') {
    return intervalItem;
  }
  if (interval === 'Weekly') {
    return monthUtils.dayFromDate(d.addDays(d.parseISO(intervalItem), 6));
  }
  if (interval === 'Yearly') {
    return `${intervalItem}-12-31`;
  }
  return monthUtils.lastDayOfMonth(intervalItem);
}

export function createSpreadsheet(
  start: string,
  end: string,
  accounts: AccountEntity[],
  conditions: RuleConditionEntity[] = [],
  conditionsOp: 'and' | 'or' = 'and',
  locale: Locale,
  interval: string = 'Monthly',
  firstDayOfWeekIdx: string = '0',
  format: (value: unknown, type?: FormatType) => string,
  dateFormat?: string,
  // Set only when multi-currency is enabled: foreign accounts are converted
  // into this currency.
  globalCurrency?: string,
) {
  return async (
    spreadsheet: ReturnType<typeof useSpreadsheet>,
    setData: (data: ReturnType<typeof recalculate>) => void,
  ) => {
    const { filters } = await send('make-filters-from-conditions', {
      conditions: conditions.filter(cond => !cond.customName),
    });
    const conditionsOpKey = conditionsOp === 'or' ? '$or' : '$and';

    // Go back exactly one interval before the selected range start
    // to get the correct starting balance for the first period
    const rangeStart = d.parseISO(monthUtils.firstDayOfMonth(start));
    let startDate: string;
    if (interval === 'Daily') {
      startDate = monthUtils.dayFromDate(d.subDays(rangeStart, 1));
    } else if (interval === 'Weekly') {
      startDate = monthUtils.weekFromDate(
        d.subDays(rangeStart, 1),
        firstDayOfWeekIdx,
      );
    } else {
      // Monthly or yearly
      startDate = monthUtils.firstDayOfMonth(monthUtils.prevMonth(start));
    }

    // If the earliest transaction is on or after the first day of the start
    // month, the prior period lookback would be empty (all zeros). Skip it to
    // avoid rendering an empty data point.
    const earliestTransaction = await send('get-earliest-transaction');
    if (
      earliestTransaction &&
      earliestTransaction.date >= monthUtils.firstDayOfMonth(start)
    ) {
      if (interval === 'Daily') {
        startDate = earliestTransaction.date;
      } else if (interval === 'Weekly') {
        startDate = monthUtils.weekFromDate(
          earliestTransaction.date,
          firstDayOfWeekIdx,
        );
      } else {
        // Monthly or Yearly
        startDate = monthUtils.firstDayOfMonth(start);
      }
    }

    // Start with the provided end-of-month date, then adjust for current context
    let endDate = monthUtils.lastDayOfMonth(end);

    if (interval === 'Daily') {
      const today = monthUtils.currentDay();
      if (monthUtils.isAfter(endDate, today)) {
        endDate = today;
      }
    } else if (interval === 'Weekly') {
      // Include the ongoing (current) week up to today instead of clamping to the
      // start of the current week. This ensures the current week appears in the
      // report even if the week hasn't finished yet.
      const today = monthUtils.currentDay();
      if (monthUtils.isAfter(endDate, today)) {
        endDate = today;
      }
    }

    const accountIds = accounts.map(account => account.id);
    const transferLegsPromise =
      accountIds.length === 0
        ? Promise.resolve<TransferLeg[]>([])
        : aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
              })
              .filter({
                account: { $oneof: accountIds },
                transfer_id: { $ne: null },
                date: { $lte: endDate },
              })
              .select(['id', 'account', 'amount', 'date', 'transfer_id']),
          ).then(({ data }: { data: TransferLeg[] }) => data);

    const accountDataPromise = Promise.all(
      accounts.map(async acct => {
        const [starting, balances]: [number, Balance[]] = await Promise.all([
          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
                account: acct.id,
                date: { $lt: startDate },
              })
              .calculate({ $sum: '$amount' }),
          ).then(({ data }) => data),

          aqlQuery(
            q('transactions')
              .filter({
                [conditionsOpKey]: filters,
              })
              .filter({
                account: acct.id,
                $and: [
                  { date: { $gte: startDate } },
                  { date: { $lte: endDate } },
                ],
              })
              .groupBy(
                interval === 'Yearly'
                  ? { $year: '$date' }
                  : interval === 'Daily' || interval === 'Weekly'
                    ? 'date'
                    : { $month: '$date' },
              )
              .select([
                {
                  date:
                    interval === 'Yearly'
                      ? { $year: '$date' }
                      : interval === 'Daily' || interval === 'Weekly'
                        ? 'date'
                        : { $month: '$date' },
                },
                { amount: { $sum: '$amount' } },
              ]),
          ).then(({ data }) => data),
        ]);

        // For weekly intervals, transform dates to week format and properly aggregate
        let processedBalances: Record<string, Balance>;
        if (interval === 'Weekly') {
          // Group transactions by week and sum their amounts
          const weeklyBalances: Record<string, number> = {};
          balances.forEach(b => {
            const weekDate = monthUtils.weekFromDate(b.date, firstDayOfWeekIdx);
            weeklyBalances[weekDate] =
              (weeklyBalances[weekDate] || 0) + b.amount;
          });

          // Convert back to Balance format
          processedBalances = {};
          Object.entries(weeklyBalances).forEach(([date, amount]) => {
            processedBalances[date] = { date, amount };
          });
        } else {
          processedBalances = keyBy(balances, b => b.date);
        }

        return {
          id: acct.id,
          name: acct.name,
          balances: processedBalances,
          starting,
        };
      }),
    );
    const [data, transferLegs] = await Promise.all([
      accountDataPromise,
      transferLegsPromise,
    ]);

    const loadedTransferIds = new Set(transferLegs.map(leg => leg.id));
    const missingCounterpartIds = [
      ...new Set(
        transferLegs
          .map(leg => leg.transfer_id)
          .filter(id => !loadedTransferIds.has(id)),
      ),
    ];

    let allTransferLegs = transferLegs;
    if (missingCounterpartIds.length > 0) {
      const counterpartLegs: TransferLeg[] = await aqlQuery(
        q('transactions')
          .filter({
            [conditionsOpKey]: filters,
          })
          .filter({
            id: { $oneof: missingCounterpartIds },
            account: { $oneof: accountIds },
            transfer_id: { $ne: null },
          })
          .select(['id', 'account', 'amount', 'date', 'transfer_id']),
      ).then(({ data }: { data: TransferLeg[] }) => data);
      allTransferLegs = [...transferLegs, ...counterpartLegs];
    }

    // Prevent paired internal transfers from changing net worth between their
    // two posting dates.
    alignInternalTransferDates(data, allTransferLegs, {
      startDate,
      endDate,
      interval,
      firstDayOfWeekIdx,
    });

    const conversion = globalCurrency
      ? await loadConversion({
          accounts,
          globalCurrency,
          startDate,
          endDate,
          interval,
          firstDayOfWeekIdx,
        })
      : undefined;

    setData(
      recalculate(
        data,
        startDate,
        endDate,
        locale,
        interval,
        firstDayOfWeekIdx,
        format,
        dateFormat,
        conversion,
      ),
    );
  };
}

// Fetches the rates once per foreign currency, covering every interval end
// date plus the starting date.
async function loadConversion({
  accounts,
  globalCurrency,
  startDate,
  endDate,
  interval,
  firstDayOfWeekIdx,
}: {
  accounts: AccountEntity[];
  globalCurrency: string;
  startDate: string;
  endDate: string;
  interval: string;
  firstDayOfWeekIdx: string;
}): Promise<NetWorthConversion | undefined> {
  const currencyByAccount: Record<string, string> = {};
  for (const account of accounts) {
    if (account.currency && account.currency !== globalCurrency) {
      currencyByAccount[account.id] = account.currency;
    }
  }
  const currencies = [...new Set(Object.values(currencyByAccount))];
  if (currencies.length === 0) {
    return undefined;
  }

  const startingDate = monthUtils.subDays(startDate, 1);
  const endDates = getIntervals(
    startDate,
    endDate,
    interval,
    firstDayOfWeekIdx,
  ).map(item => getIntervalEndDate(item, interval));
  const dates = [startingDate, ...endDates];

  const ratesByCurrency: Record<string, Record<string, number | null>> = {};
  await Promise.all(
    currencies.map(async from => {
      const result = await send('exchange-rates-get', {
        from,
        to: globalCurrency,
        dates,
      });
      ratesByCurrency[from] = result.rates;
    }),
  );

  return {
    globalCurrency,
    currencyByAccount,
    rateFor: (accountId, index) => {
      const currency = currencyByAccount[accountId];
      const date = index === -1 ? startingDate : endDates[index];
      return ratesByCurrency[currency]?.[date] ?? null;
    },
  };
}

function alignInternalTransferDates(
  data: AccountBalanceData[],
  transferLegs: TransferLeg[],
  range: IntervalRange,
) {
  const accountsById = new Map(data.map(account => [account.id, account]));
  const transfersById = new Map(transferLegs.map(leg => [leg.id, leg]));
  const processed = new Set<string>();

  transferLegs.forEach(leg => {
    if (processed.has(leg.id)) {
      return;
    }

    const counterpart = transfersById.get(leg.transfer_id);
    if (
      !counterpart ||
      counterpart.transfer_id !== leg.id ||
      counterpart.account === leg.account ||
      counterpart.amount + leg.amount !== 0 ||
      !accountsById.has(leg.account) ||
      !accountsById.has(counterpart.account)
    ) {
      return;
    }

    processed.add(leg.id);
    processed.add(counterpart.id);

    if (leg.date === counterpart.date) {
      return;
    }

    const [earlier, later] =
      leg.date < counterpart.date ? [leg, counterpart] : [counterpart, leg];

    const account = accountsById.get(earlier.account);
    if (account) {
      moveTransferLeg(account, earlier, later.date, range);
    }
  });
}

function moveTransferLeg(
  account: AccountBalanceData,
  leg: TransferLeg,
  laterDate: string,
  range: IntervalRange,
) {
  const { startDate, endDate, interval, firstDayOfWeekIdx } = range;
  if (laterDate < startDate) {
    return;
  }

  if (leg.date < startDate) {
    account.starting -= leg.amount;
  } else {
    if (leg.date > endDate) {
      return;
    }
    const originalKey = getIntervalKey(leg.date, interval, firstDayOfWeekIdx);
    const originalBalance = account.balances[originalKey];
    if (!originalBalance) {
      return;
    }
    originalBalance.amount -= leg.amount;
  }

  if (laterDate > endDate) {
    return;
  }

  const intervalKey = getIntervalKey(laterDate, interval, firstDayOfWeekIdx);
  const balance = account.balances[intervalKey];
  if (balance) {
    balance.amount += leg.amount;
  } else {
    account.balances[intervalKey] = { date: intervalKey, amount: leg.amount };
  }
}

function getIntervalKey(
  date: string,
  interval: string,
  firstDayOfWeekIdx: string,
) {
  if (interval === 'Daily') {
    return date;
  }
  if (interval === 'Weekly') {
    return monthUtils.weekFromDate(date, firstDayOfWeekIdx);
  }
  if (interval === 'Yearly') {
    return date.slice(0, 4);
  }
  return monthUtils.getMonth(date);
}

function recalculate(
  data: AccountBalanceData[],
  startDate: string,
  endDate: string,
  locale: Locale,
  interval: string = 'Monthly',
  firstDayOfWeekIdx: string = '0',
  format: (value: unknown, type?: FormatType) => string,
  dateFormat?: string,
  conversion?: NetWorthConversion,
) {
  const intervals = getIntervals(
    startDate,
    endDate,
    interval,
    firstDayOfWeekIdx,
  );

  const missingPairs = new Set<string>();
  // Converts a native balance into the global currency. Returns null (and
  // records the pair) when the rate is unavailable. Accounts in the global
  // currency are returned as they are.
  const convert = (
    account: AccountBalanceData,
    native: number,
    index: number,
  ): number | null => {
    const currency = conversion?.currencyByAccount[account.id];
    if (!conversion || !currency) {
      return native;
    }
    const rate = conversion.rateFor(account.id, index);
    if (rate == null) {
      missingPairs.add(`${currency} → ${conversion.globalCurrency}`);
      return null;
    }
    return convertAmount(
      native,
      rate,
      getDecimalPlaces(currency),
      getDecimalPlaces(conversion.globalCurrency),
    );
  };

  const nativeBalances = data.map(account => {
    let balance = account.starting;
    return intervals.map(intervalItem => {
      if (account.balances[intervalItem]) {
        balance += account.balances[intervalItem].amount;
      }
      return balance;
    });
  });

  const accountBalances = data.map((account, i) =>
    nativeBalances[i].map((native, idx) => convert(account, native, idx)),
  );

  let priorPeriodNetWorth: number | null = 0;
  for (const account of data) {
    const converted = convert(account, account.starting, -1);
    priorPeriodNetWorth =
      priorPeriodNetWorth == null || converted == null
        ? null
        : priorPeriodNetWorth + converted;
  }

  let hasNegative = false;
  let startNetWorth: number | null = 0;
  let endNetWorth: number | null = 0;
  let lowestNetWorth: number | null = null;
  let highestNetWorth: number | null = null;

  const graphData = intervals.reduce<
    Array<{
      x: string;
      /** Null when an exchange rate is missing for this interval. */
      y: number | null;
      assets: string;
      debt: string;
      change: string;
      networth: string;
      date: string;
      hasMissingRate: boolean;
    }>
  >((arr, intervalItem, idx) => {
    let debt = 0;
    let assets = 0;
    let total: number | null = 0;
    const last = arr.length === 0 ? null : arr[arr.length - 1];

    const balances: Record<string, number | null> = {};
    accountBalances.forEach((acctBalances, i) => {
      const balance = acctBalances[idx];
      balances[data[i].id] = balance;

      if (balance == null) {
        total = null;
        return;
      }
      if (balance < 0) {
        debt += -balance;
      } else {
        assets += balance;
      }
      if (total != null) {
        total += balance;
      }
    });

    if (total != null && total < 0) {
      hasNegative = true;
    }

    // Parse dates based on interval type - following the working pattern
    let x: Date;
    if (interval === 'Daily' || interval === 'Weekly') {
      x = d.parseISO(intervalItem);
    } else if (interval === 'Yearly') {
      x = d.parseISO(intervalItem + '-01-01');
    } else {
      x = d.parseISO(intervalItem + '-01');
    }

    const previousTotal = last ? last.y : priorPeriodNetWorth;
    const change =
      total == null || previousTotal == null ? null : total - previousTotal;

    if (arr.length === 0) {
      startNetWorth = total;
    }
    endNetWorth = total;

    // Use standardized format from ReportOptions, following the user's date
    // format preference for the day-level intervals.
    const displayFormat = getIntervalFormat(interval, dateFormat) || "MMM ''yy";

    const tooltipFormat =
      interval === 'Daily'
        ? 'MMMM d, yyyy'
        : interval === 'Weekly'
          ? 'MMM d, yyyy'
          : interval === 'Yearly'
            ? 'yyyy'
            : 'MMMM yyyy';

    const graphPoint = {
      x: d.format(x, displayFormat, { locale }),
      y: total,
      assets: total == null ? '—' : format(assets, 'financial'),
      debt: total == null ? '—' : `-${format(debt, 'financial')}`,
      change: change == null ? '—' : format(change, 'financial'),
      networth: total == null ? '—' : format(total, 'financial'),
      date: d.format(x, tooltipFormat, { locale }),
      hasMissingRate: total == null,
      ...balances,
    };

    arr.push(graphPoint);

    // Track min/max for the current point only
    if (graphPoint.y != null) {
      if (lowestNetWorth === null || graphPoint.y < lowestNetWorth) {
        lowestNetWorth = graphPoint.y;
      }
      if (highestNetWorth === null || graphPoint.y > highestNetWorth) {
        highestNetWorth = graphPoint.y;
      }
    }

    return arr;
  }, []);

  const hasBalance = nativeBalances.map(balances =>
    balances.some(b => b !== 0),
  );

  return {
    graphData: {
      data: graphData,
      hasNegative,
      start: startDate,
      end: endDate,
    },
    netWorth: endNetWorth,
    totalChange:
      endNetWorth == null || startNetWorth == null
        ? null
        : endNetWorth - startNetWorth,
    /** Currency pairs whose exchange rate is unavailable for some periods. */
    missingPairs: [...missingPairs],
    lowestNetWorth,
    highestNetWorth,
    accounts: data
      .filter((_, i) => hasBalance[i])
      .map(d => ({ id: d.id, name: d.name })),
  };
}
