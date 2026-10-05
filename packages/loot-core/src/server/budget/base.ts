import { aqlQuery } from '#server/aql';
import {
  getBudgetSpaces,
  validateBudgetExists,
} from '#server/budget-spaces/helpers';
import * as db from '#server/db';
import * as sheet from '#server/sheet';
import { resolveName, unresolveName } from '#server/spreadsheet/util';
// @ts-strict-ignore
import * as monthUtils from '#shared/months';
import { q } from '#shared/query';
import { getChangedValues } from '#shared/util';
import type { CategoryGroupEntity } from '#types/models';

import * as budgetActions from './actions';
import * as envelopeBudget from './envelope';
import * as trackingBudget from './tracking';

export function getBudgetType(budgetId: string) {
  const budgetType = sheet.get().getBudgetMeta(budgetId).budgetType;
  if (budgetType !== 'envelope' && budgetType !== 'tracking') {
    throw new Error(
      `Unknown budget type for ${budgetId}: ${String(budgetType)}`,
    );
  }
  return budgetType;
}

export function isTrackingBudget(budgetId: string) {
  return getBudgetType(budgetId) === 'tracking';
}

export function getBudgetRange(start: string, end: string) {
  start = monthUtils.getMonth(start);
  end = monthUtils.getMonth(end);

  // The start date should never be after the end date. If that
  // happened, the month range might be a valid range and weird
  // things happen
  if (start > end) {
    start = end;
  }

  // Budgets should exist 3 months before the earliest needed date
  // (either the oldest transaction or the current month if no
  // transactions yet), and a year from the current date. There's no
  // need to ever have budgets outside that range.
  start = monthUtils.subMonths(start, 3);
  end = monthUtils.addMonths(end, 12);

  return { start, end, range: monthUtils.rangeInclusive(start, end) };
}

// Computes the spend total for every category in every month within the
// given day range using a single grouped query. This is used to seed the
// `sum-amount` cells on a cold build so we avoid running one
// `SELECT SUM(amount)` query per category per month (which scales as
// categories × months and dominates load time for budgets with many years
// of data). The filters must match the per-cell query in `createCategory`
// exactly so balances stay identical.
function getSumAmountsByMonth(
  budgetId: string,
  rangeStart: number,
  rangeEnd: number,
): Map<string, number> {
  const rows = db.runQuery<{ month: number; category: string; amount: number }>(
    `SELECT t.category AS category,
            t.date / 100 AS month,
            SUM(t.amount) AS amount
       FROM v_transactions_internal_alive t
       JOIN accounts a ON a.id = t.account
       JOIN categories c ON c.id = t.category
      WHERE t.date >= ? AND t.date <= ?
        AND t.category IS NOT NULL
        AND a.offbudget = 0
        AND a.budget_id = ?
        AND c.budget_id = ?
      GROUP BY t.category, t.date / 100`,
    [rangeStart, rangeEnd, budgetId, budgetId],
    true,
  );

  const sums = new Map<string, number>();
  for (const row of rows) {
    sums.set(`${row.month}-${row.category}`, row.amount || 0);
  }
  return sums;
}

export function createCategory(
  budgetId,
  cat,
  sheetName,
  prevSheetName,
  start,
  end,
) {
  sheet.get().createDynamic(sheetName, 'sum-amount-' + cat.id, {
    initialValue: 0,
    run: () => {
      // Making this sync is faster!
      const rows = db.runQuery<{ amount: number }>(
        `SELECT SUM(amount) as amount FROM v_transactions_internal_alive t
           JOIN accounts a ON a.id = t.account
           JOIN categories c ON c.id = t.category
         WHERE t.date >= ? AND t.date <= ?
           AND category = ? AND a.offbudget = 0
           AND a.budget_id = ? AND c.budget_id = ?`,
        [start, end, cat.id, budgetId, budgetId],
        true,
      );
      const row = rows[0];
      const amount = row ? row.amount : 0;
      return amount || 0;
    },
  });

  if (getBudgetType(budgetId) === 'envelope') {
    envelopeBudget.createCategory(cat, sheetName, prevSheetName);
  } else {
    void trackingBudget.createCategory(cat, sheetName, prevSheetName);
  }
}

function handleTransactionChange(budgetId, transaction, changedFields) {
  if (
    (changedFields.has('date') ||
      changedFields.has('acct') ||
      changedFields.has('amount') ||
      changedFields.has('category') ||
      changedFields.has('tombstone') ||
      changedFields.has('isParent')) &&
    transaction.date &&
    transaction.category
  ) {
    const month = monthUtils.monthFromDate(db.fromDateRepr(transaction.date));
    const sheetName = monthUtils.sheetForMonth(budgetId, month);
    sheet
      .get()
      .recompute(resolveName(sheetName, 'sum-amount-' + transaction.category));
  }
}

function handleCategoryMappingChange(budgetId, months, oldValue, newValue) {
  months.forEach(month => {
    const sheetName = monthUtils.sheetForMonth(budgetId, month);
    if (oldValue) {
      sheet
        .get()
        .recompute(resolveName(sheetName, 'sum-amount-' + oldValue.transferId));
    }
    sheet
      .get()
      .recompute(resolveName(sheetName, 'sum-amount-' + newValue.transferId));
  });
}

function handleBudgetMonthChange(budgetMonth) {
  const month = budgetMonth.month;
  if (!month) return;
  const sheetName = monthUtils.sheetForMonth(budgetMonth.budget_id, month);
  sheet.get().set(`${sheetName}!buffered`, budgetMonth.buffered);
}

function handleBudgetChange(budget) {
  if (budget.category) {
    const month = String(budget.month);
    const sheetName = monthUtils.sheetForMonth(
      budget.budget_id,
      `${month.slice(0, 4)}-${month.slice(4)}`,
    );
    sheet
      .get()
      .set(`${sheetName}!budget-${budget.category}`, budget.amount || 0);
    sheet
      .get()
      .set(`${sheetName}!carryover-${budget.category}`, budget.carryover === 1);
    sheet.get().set(`${sheetName}!goal-${budget.category}`, budget.goal);
    sheet
      .get()
      .set(`${sheetName}!long-goal-${budget.category}`, budget.long_goal);
  }
}

function getTransactionBudgetId(transaction) {
  if (!transaction?.acct) return null;
  return (
    db.firstSync<{ budget_id: string }>(
      'SELECT budget_id FROM accounts WHERE id = ?',
      [transaction.acct],
    )?.budget_id ?? null
  );
}

export function triggerBudgetChanges(oldValues, newValues) {
  const budgetChanges: Array<{ id: string; type: string; isNew: boolean }> = [];
  sheet.startTransaction();

  try {
    newValues.forEach((items, table) => {
      const old = oldValues.get(table);
      items.forEach(newValue => {
        const oldValue = old && old.get(newValue.id);
        const budgetId = newValue.budget_id ?? oldValue?.budget_id;

        if (table === 'zero_budget_months') {
          handleBudgetMonthChange(newValue);
        } else if (
          (table === 'zero_budgets' || table === 'reflect_budgets') &&
          budgetId &&
          (table === 'reflect_budgets') === isTrackingBudget(budgetId)
        ) {
          handleBudgetChange(newValue);
        } else if (table === 'transactions') {
          const changed = new Set(
            Object.keys(getChangedValues(oldValue || {}, newValue) || {}),
          );
          if (oldValue) {
            const oldBudgetId = getTransactionBudgetId(oldValue);
            if (oldBudgetId) {
              handleTransactionChange(oldBudgetId, oldValue, changed);
            }
          }
          const newBudgetId = getTransactionBudgetId(newValue);
          if (newBudgetId) {
            handleTransactionChange(newBudgetId, newValue, changed);
          }
        } else if (table === 'category_mapping') {
          const categoryOwner = db.firstSync<{ budget_id: string }>(
            'SELECT budget_id FROM categories WHERE id = ?',
            [newValue.id],
          )?.budget_id;
          if (categoryOwner) {
            const months = sheet
              .get()
              .getBudgetMeta(categoryOwner).createdMonths;
            handleCategoryMappingChange(
              categoryOwner,
              months,
              oldValue,
              newValue,
            );
          }
        } else if (table === 'categories' && budgetId) {
          const months = sheet.get().getBudgetMeta(budgetId).createdMonths;
          const handle =
            getBudgetType(budgetId) === 'envelope'
              ? envelopeBudget.handleCategoryChange
              : trackingBudget.handleCategoryChange;
          handle(budgetId, months, oldValue, newValue);
        } else if (table === 'category_groups' && budgetId) {
          const months = sheet.get().getBudgetMeta(budgetId).createdMonths;
          const handle =
            getBudgetType(budgetId) === 'envelope'
              ? envelopeBudget.handleCategoryGroupChange
              : trackingBudget.handleCategoryGroupChange;
          handle(budgetId, months, oldValue, newValue);
        } else if (
          table === 'accounts' &&
          budgetId &&
          (!oldValue || oldValue.offbudget !== newValue.offbudget)
        ) {
          const rows = db.runQuery<Pick<db.DbTransaction, 'category'>>(
            'SELECT DISTINCT(category) AS category FROM transactions WHERE acct = ?',
            [newValue.id],
            true,
          );
          for (const month of sheet.get().getBudgetMeta(budgetId)
            .createdMonths) {
            const sheetName = monthUtils.sheetForMonth(budgetId, month);
            for (const row of rows) {
              sheet
                .get()
                .recompute(
                  resolveName(sheetName, 'sum-amount-' + row.category),
                );
            }
          }
        } else if (table === 'budgets') {
          budgetChanges.push({
            id: newValue.id,
            type: newValue.budget_type,
            isNew: !oldValue,
          });
        }
      });
    });
  } finally {
    sheet.endTransaction();
  }
  return budgetChanges;
}

export async function doTransfer(budgetId, categoryIds, transferId) {
  const { createdMonths: months } = sheet.get().getBudgetMeta(budgetId);
  [...months].forEach(month => {
    const totalValue = categoryIds
      .map(id => budgetActions.getBudget({ budgetId, month, category: id }))
      .reduce((total, value) => total + value, 0);
    const transferValue = budgetActions.getBudget({
      budgetId,
      month,
      category: transferId,
    });
    void budgetActions.setBudget({
      budgetId,
      month,
      category: transferId,
      amount: totalValue + transferValue,
    });
  });
}

export async function createBudget(budgetId: string, months: string[]) {
  await validateBudgetExists(budgetId);
  const { data: groups }: { data: CategoryGroupEntity[] } = await aqlQuery(
    q('category_groups').filter({ budget_id: budgetId }).select('*'),
  );
  const categories = groups
    .flatMap(group => group.categories ?? [])
    .filter(cat => cat.budget_id === budgetId);

  sheet.startTransaction();
  const meta = sheet.get().getBudgetMeta(budgetId);
  meta.createdMonths = meta.createdMonths || new Set();

  const budgetType = getBudgetType(budgetId);

  if (budgetType === 'envelope') {
    envelopeBudget.createBudget(budgetId, meta, categories, months);
  }

  // Only months that don't already exist need to be created and seeded.
  const monthsToCreate = months.filter(month => !meta.createdMonths.has(month));

  // Spend totals for every category in the months being created, computed
  // once via a single grouped query and used to seed the `sum-amount` cells so
  // they don't each run their own query. Scoped to the uncached month span so
  // extending the budget horizon doesn't rescan the entire transaction
  // history, and loaded lazily so warm loads never touch the database here.
  let sumAmounts: Map<string, number> | null = null;
  const getSumAmounts = () => {
    if (!sumAmounts) {
      // `monthsToCreate` isn't guaranteed to be sorted, so find the span
      // explicitly ('YYYY-MM' strings compare chronologically).
      let firstMonth = monthsToCreate[0];
      let lastMonth = monthsToCreate[0];
      for (const month of monthsToCreate) {
        if (month < firstMonth) {
          firstMonth = month;
        }
        if (month > lastMonth) {
          lastMonth = month;
        }
      }
      sumAmounts = getSumAmountsByMonth(
        budgetId,
        monthUtils.bounds(firstMonth).start,
        monthUtils.bounds(lastMonth).end,
      );
    }
    return sumAmounts;
  };
  const seededCells: string[] = [];

  monthsToCreate.forEach(month => {
    const prevMonth = monthUtils.prevMonth(month);
    const { start, end } = monthUtils.bounds(month);
    const sheetName = monthUtils.sheetForMonth(budgetId, month);
    const prevSheetName = monthUtils.sheetForMonth(budgetId, prevMonth);
    const dbMonth = parseInt(month.replace('-', ''));

    categories.forEach(cat => {
      // Seed the spend total before creating the dynamic cell so the cell
      // skips its per-category query. Only happens on a cold build, when
      // the value hasn't been restored from cache.
      const sumCell = `sum-amount-${cat.id}`;
      if (sheet.get().getCellValueLoose(sheetName, sumCell) == null) {
        const name = resolveName(sheetName, sumCell);
        sheet
          .get()
          .load(name, getSumAmounts().get(`${dbMonth}-${cat.id}`) || 0);
        seededCells.push(name);
      }
      createCategory(budgetId, cat, sheetName, prevSheetName, start, end);
    });
    groups.forEach(group => {
      if (budgetType === 'envelope') {
        envelopeBudget.createCategoryGroup(group, sheetName);
      } else {
        trackingBudget.createCategoryGroup(group, sheetName);
      }
    });

    if (budgetType === 'envelope') {
      envelopeBudget.createSummary(
        groups,
        categories,
        prevSheetName,
        sheetName,
      );
    } else {
      trackingBudget.createSummary(groups, sheetName);
    }

    meta.createdMonths.add(month);
  });

  sheet.endTransaction();

  // Persist the seeded spend totals to the cache. Because they were loaded
  // directly (rather than recomputed) they aren't part of the computation
  // queue that normally gets cached, so without this a warm load would have
  // to recompute them. The cells already hold their final values here.
  if (seededCells.length > 0) {
    sheet.get().saveCachedCells(seededCells);
  }

  // Wait for the spreadsheet to finish computing. Normally this won't
  // do anything (as values are cached) but on first run this need to
  // show the loading screen while it initially sets up.
  await sheet.waitOnSpreadsheet();
}

export async function createAllBudgets(budgetId: string) {
  await validateBudgetExists(budgetId);
  const earliestTransaction = await db.first<db.DbTransaction>(
    `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.acct
      WHERE a.budget_id = ? AND t.isChild = 0 AND t.date IS NOT NULL
      ORDER BY t.date ASC LIMIT 1`,
    [budgetId],
  );
  const earliestTransactionMonth = earliestTransaction
    ? monthUtils.monthFromDate(db.fromDateRepr(earliestTransaction.date))
    : null;
  const earliestStoredBudget = await db.first<{ month: number | null }>(
    `SELECT MIN(month_number) AS month FROM (
       SELECT CAST(month AS INTEGER) AS month_number FROM zero_budgets WHERE budget_id = ?
       UNION ALL
       SELECT CAST(month AS INTEGER) AS month_number FROM reflect_budgets WHERE budget_id = ?
       UNION ALL
       SELECT CAST(REPLACE(month, '-', '') AS INTEGER) AS month_number
         FROM zero_budget_months WHERE budget_id = ?
     )`,
    [budgetId, budgetId, budgetId],
  );
  const storedMonthNumber = earliestStoredBudget?.month;
  const earliestStoredMonth =
    storedMonthNumber == null
      ? null
      : `${String(storedMonthNumber).padStart(6, '0').slice(0, 4)}-${String(storedMonthNumber).padStart(6, '0').slice(4)}`;
  const earliestMonth = [earliestTransactionMonth, earliestStoredMonth]
    .filter((month): month is string => month != null)
    .sort()[0];
  const currentMonth = monthUtils.currentMonth();
  const { start, end, range } = getBudgetRange(
    earliestMonth || currentMonth,
    currentMonth,
  );

  const meta = sheet.get().getBudgetMeta(budgetId);
  const newMonths = range.filter(month => !meta.createdMonths.has(month));
  if (newMonths.length > 0) {
    await createBudget(budgetId, range);
  }
  return { start, end };
}

export async function createAllBudgetSpaces() {
  const budgets = await getBudgetSpaces();
  const bounds = new Map<string, { start: string; end: string }>();
  for (const budgetSpace of budgets) {
    if (
      budgetSpace.budget_type !== 'envelope' &&
      budgetSpace.budget_type !== 'tracking'
    ) {
      throw new Error(
        `Unknown budget type for ${budgetSpace.id}: ${budgetSpace.budget_type}`,
      );
    }
    sheet.get().getBudgetMeta(budgetSpace.id).budgetType =
      budgetSpace.budget_type;
    bounds.set(budgetSpace.id, await createAllBudgets(budgetSpace.id));
  }
  return bounds;
}

export async function setBudgetType(
  budgetId: string,
  type: 'envelope' | 'tracking',
) {
  const meta = sheet.get().getBudgetMeta(budgetId);
  if (type === meta.budgetType) return;
  meta.budgetType = type;
  meta.createdMonths = new Set();
  meta.blankSheet = undefined;

  for (const name of sheet.get().getNodes().keys()) {
    const resolved = unresolveName(name);
    if (
      resolved.sheet &&
      monthUtils.budgetIdFromSheetName(resolved.sheet) === budgetId
    ) {
      sheet.get().deleteCell(resolved.sheet, resolved.name);
    }
  }

  sheet.get().startCacheBarrier();
  await sheet.loadUserBudgets(db, budgetId);
  const bounds = await createAllBudgets(budgetId);
  sheet.get().endCacheBarrier();
  return bounds;
}
