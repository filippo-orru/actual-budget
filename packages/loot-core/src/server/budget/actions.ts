// @ts-strict-ignore

import * as asyncStorage from '#platform/server/asyncStorage';
import * as db from '#server/db';
import * as sheet from '#server/sheet';
import { batchMessages } from '#server/sync';
import { budgetMonthId, DEFAULT_BUDGET_ID } from '#shared/budget-spaces';
import { getCurrency } from '#shared/currencies';
import { getLocale } from '#shared/locale';
import * as monthUtils from '#shared/months';
import { integerToCurrency, safeNumber } from '#shared/util';
import type { IntegerAmount } from '#shared/util';
import type { CategoryEntity } from '#types/models';

export async function getSheetValue(
  sheetName: string,
  cell: string,
): Promise<number> {
  const node = sheet.getCell(sheetName, cell);
  return safeNumber(typeof node.value === 'number' ? node.value : 0);
}

export async function getSheetBoolean(
  sheetName: string,
  cell: string,
): Promise<boolean> {
  const node = sheet.getCell(sheetName, cell);
  return typeof node.value === 'boolean' ? node.value : false;
}

// We want to only allow the positive movement of money back and
// forth. buffered should never be allowed to go into the negative,
// and you shouldn't be allowed to pull non-existent money from
// leftover.
function calcBufferedAmount(
  toBudget: number,
  buffered: number,
  amount: number,
): number {
  amount = Math.min(Math.max(amount, -buffered), Math.max(toBudget, 0));
  return buffered + amount;
}

type BudgetTable = 'reflect_budgets' | 'zero_budgets';

export function getBudgetTable(budgetId: string): BudgetTable {
  const budget = db.firstSync<{ budget_type: string }>(
    'SELECT budget_type FROM budgets WHERE id = ? AND tombstone = 0',
    [budgetId],
  );
  if (!budget) throw new Error(`Budget not found: ${budgetId}`);
  if (budget.budget_type !== 'envelope' && budget.budget_type !== 'tracking') {
    throw new Error(
      `Unknown budget type for ${budgetId}: ${budget.budget_type}`,
    );
  }
  return budget.budget_type === 'tracking' ? 'reflect_budgets' : 'zero_budgets';
}

export function isTrackingBudget(budgetId: string): boolean {
  return getBudgetTable(budgetId) === 'reflect_budgets';
}

function assertCategoryOwner(budgetId: string, categoryId: string): void {
  const category = db.firstSync<{ budget_id: string }>(
    'SELECT budget_id FROM categories WHERE id = ?',
    [categoryId],
  );
  if (!category || category.budget_id !== budgetId) {
    throw new Error('Category does not belong to the requested budget');
  }
}

function dbMonth(month: string): number {
  return parseInt(month.replace('-', ''));
}

function monthFromDbMonth(month: number): string {
  const monthString = String(month).padStart(6, '0');
  return `${monthString.slice(0, 4)}-${monthString.slice(4)}`;
}

// TODO: complete list of fields.
type BudgetData = {
  is_income: 1 | 0;
  hidden: 1 | 0;
  group_hidden: 1 | 0;
  category: string;
  amount: number;
};

function getBudgetData<T extends BudgetTable>(
  table: T,
  month: string,
  budgetId: string,
): Promise<BudgetData[]> {
  return db.all<
    (db.DbReflectBudget | db.DbZeroBudget) &
      Pick<
        db.DbViewCategoryWithGroupHidden,
        'is_income' | 'hidden' | 'group_hidden'
      >
  >(
    `
    SELECT b.*, c.is_income, c.hidden, g.hidden AS group_hidden
    FROM ${table} b
    LEFT JOIN categories c ON b.category = c.id
    LEFT JOIN category_groups g ON c.cat_group = g.id
    WHERE c.tombstone = 0 AND b.month = ? AND b.budget_id = ?
      AND c.budget_id = ? AND g.budget_id = ?
  `,
    [month, budgetId, budgetId, budgetId],
  );
}

function getAllMonths(budgetId: string, startMonth: string): string[] {
  const { createdMonths } = sheet.get().getBudgetMeta(budgetId);
  let latest = null;
  for (const month of createdMonths) {
    if (latest == null || month > latest) {
      latest = month;
    }
  }
  return monthUtils.rangeInclusive(startMonth, latest);
}

// TODO: Valid month format in all the functions below

export function getBudget({
  budgetId,
  category,
  month,
}: {
  budgetId: string;
  category: string;
  month: string;
}): number {
  assertCategoryOwner(budgetId, category);
  const table = getBudgetTable(budgetId);
  const existing = db.firstSync<db.DbZeroBudget | db.DbReflectBudget>(
    `SELECT * FROM ${table} WHERE month = ? AND category = ? AND budget_id = ?`,
    [dbMonth(month), category, budgetId],
  );
  return existing ? existing.amount || 0 : 0;
}

export function setBudget({
  budgetId,
  category,
  month,
  amount,
}: {
  budgetId: string;
  category: CategoryEntity['id'];
  month: string;
  amount: unknown;
}): Promise<void> {
  amount = safeNumber(typeof amount === 'number' ? amount : 0);
  if (category === 'to-budget' || category === 'overbudgeted') {
    return Promise.resolve();
  }
  assertCategoryOwner(budgetId, category);
  const table = getBudgetTable(budgetId);

  const existing = db.firstSync<
    Pick<db.DbZeroBudget | db.DbReflectBudget, 'id'>
  >(
    `SELECT id FROM ${table} WHERE month = ? AND category = ? AND budget_id = ?`,
    [dbMonth(month), category, budgetId],
  );
  if (existing) {
    return db.update(table, { id: existing.id, amount });
  }
  return db.insert(table, {
    id: `${dbMonth(month)}-${category}`,
    month: dbMonth(month),
    category,
    budget_id: budgetId,
    amount,
  });
}

export function setGoal({
  budgetId,
  month,
  category,
  goal,
  long_goal,
}: {
  budgetId: string;
  month: string;
  category: string;
  goal: unknown;
  long_goal: unknown;
}): Promise<void> {
  assertCategoryOwner(budgetId, category);
  const table = getBudgetTable(budgetId);
  const existing = db.firstSync<
    Pick<db.DbZeroBudget | db.DbReflectBudget, 'id'>
  >(
    `SELECT id FROM ${table} WHERE month = ? AND category = ? AND budget_id = ?`,
    [dbMonth(month), category, budgetId],
  );
  if (existing) {
    return db.update(table, {
      id: existing.id,
      goal,
      long_goal,
    });
  }
  return db.insert(table, {
    id: `${dbMonth(month)}-${category}`,
    month: dbMonth(month),
    category,
    budget_id: budgetId,
    goal,
    long_goal,
  });
}

export function setBuffer(
  budgetId: string,
  month: string,
  amount: unknown,
): Promise<void> {
  getBudgetTable(budgetId);
  const id = budgetMonthId(budgetId, month);
  const existing = db.firstSync<Pick<db.DbZeroBudgetMonth, 'id'>>(
    'SELECT id FROM zero_budget_months WHERE id = ? AND budget_id = ?',
    [id, budgetId],
  );
  if (existing) {
    return db.update('zero_budget_months', {
      id: existing.id,
      buffered: amount,
    });
  }
  return db.insert('zero_budget_months', {
    id,
    month,
    budget_id: budgetId,
    buffered: amount,
  });
}

function setCarryover(
  budgetId: string,
  table: string,
  category: string,
  month: string,
  flag: boolean,
): Promise<void> {
  const existing = db.firstSync<
    Pick<db.DbZeroBudget | db.DbReflectBudget, 'id'>
  >(
    `SELECT id FROM ${table} WHERE month = ? AND category = ? AND budget_id = ?`,
    [month, category, budgetId],
  );
  if (existing) {
    return db.update(table, { id: existing.id, carryover: flag ? 1 : 0 });
  }
  return db.insert(table, {
    id: `${month}-${category}`,
    month,
    category,
    budget_id: budgetId,
    carryover: flag ? 1 : 0,
  });
}

// Actions

export async function copyPreviousMonth({
  budgetId,
  month,
}: {
  budgetId: string;
  month: string;
}): Promise<void> {
  const prevMonth = dbMonth(monthUtils.prevMonth(month));
  const table = getBudgetTable(budgetId);
  const budgetData = await getBudgetData(table, prevMonth.toString(), budgetId);

  await batchMessages(async () => {
    budgetData.forEach(prevBudget => {
      if (prevBudget.is_income === 1 && !isTrackingBudget(budgetId)) {
        return;
      }
      if (prevBudget.hidden === 1 || prevBudget.group_hidden === 1) {
        return;
      }
      void setBudget({
        budgetId,
        category: prevBudget.category,
        month,
        amount: prevBudget.amount,
      });
    });
  });
}

export async function copySinglePreviousMonth({
  budgetId,
  month,
  category,
}: {
  budgetId: string;
  month: string;
  category: string;
}): Promise<void> {
  assertCategoryOwner(budgetId, category);
  const prevMonth = monthUtils.prevMonth(month);
  const newAmount = await getSheetValue(
    monthUtils.sheetForMonth(budgetId, prevMonth),
    'budget-' + category,
  );
  await batchMessages(async () => {
    void setBudget({ budgetId, category, month, amount: newAmount });
  });
}

export async function setZero({
  budgetId,
  month,
}: {
  budgetId: string;
  month: string;
}): Promise<void> {
  getBudgetTable(budgetId);
  const categories = await db.all<db.DbViewCategory>(
    'SELECT * FROM v_categories WHERE tombstone = 0 AND budget_id = ?',
    [budgetId],
  );

  await batchMessages(async () => {
    categories.forEach(cat => {
      if (cat.is_income === 1 && !isTrackingBudget(budgetId)) {
        return;
      }
      void setBudget({ budgetId, category: cat.id, month, amount: 0 });
    });
  });
}

export async function set3MonthAvg({
  budgetId,
  month,
}: {
  budgetId: string;
  month: string;
}): Promise<void> {
  const categories = await db.all<db.DbViewCategoryWithGroupHidden>(
    `
  SELECT c.*
  FROM categories c
  LEFT JOIN category_groups g ON c.cat_group = g.id
  WHERE c.tombstone = 0 AND c.hidden = 0 AND g.hidden = 0
    AND c.budget_id = ? AND g.budget_id = ?
  `,
    [budgetId, budgetId],
  );

  await batchMessages(async () => {
    for (const cat of categories) {
      if (cat.is_income === 1 && !isTrackingBudget(budgetId)) {
        continue;
      }

      let avg = await getCategoryAverage({
        budgetId,
        month,
        maxMonths: 3,
        categoryId: cat.id,
      });

      if (cat.is_income === 0) {
        avg *= -1;
      }

      void setBudget({ budgetId, category: cat.id, month, amount: avg });
    }
  });
}

export async function set12MonthAvg({
  budgetId,
  month,
}: {
  budgetId: string;
  month: string;
}): Promise<void> {
  const categories = await db.all<db.DbViewCategoryWithGroupHidden>(
    `
  SELECT c.*
  FROM categories c
  LEFT JOIN category_groups g ON c.cat_group = g.id
  WHERE c.tombstone = 0 AND c.hidden = 0 AND g.hidden = 0
    AND c.budget_id = ? AND g.budget_id = ?
  `,
    [budgetId, budgetId],
  );

  await batchMessages(async () => {
    for (const cat of categories) {
      if (cat.is_income === 1 && !isTrackingBudget(budgetId)) {
        continue;
      }
      void setNMonthAvg({ budgetId, month, N: 12, category: cat.id });
    }
  });
}

export async function set6MonthAvg({
  budgetId,
  month,
}: {
  budgetId: string;
  month: string;
}): Promise<void> {
  const categories = await db.all<db.DbViewCategoryWithGroupHidden>(
    `
  SELECT c.*
  FROM categories c
  LEFT JOIN category_groups g ON c.cat_group = g.id
  WHERE c.tombstone = 0 AND c.hidden = 0 AND g.hidden = 0
    AND c.budget_id = ? AND g.budget_id = ?
  `,
    [budgetId, budgetId],
  );

  await batchMessages(async () => {
    for (const cat of categories) {
      if (cat.is_income === 1 && !isTrackingBudget(budgetId)) {
        continue;
      }
      void setNMonthAvg({ budgetId, month, N: 6, category: cat.id });
    }
  });
}

export async function setNMonthAvg({
  budgetId,
  month,
  N,
  category,
}: {
  budgetId: string;
  month: string;
  N: number;
  category: string;
}): Promise<void> {
  const categoryFromDb = await db.first<Pick<db.DbViewCategory, 'is_income'>>(
    'SELECT is_income FROM v_categories WHERE id = ? AND budget_id = ?',
    [category, budgetId],
  );

  let avg = await getCategoryAverage({
    budgetId,
    month,
    maxMonths: N,
    categoryId: category,
  });

  await batchMessages(async () => {
    if (categoryFromDb.is_income === 0) {
      avg *= -1;
    }

    void setBudget({ budgetId, category, month, amount: avg });
  });
}

export async function getCategoryAverage({
  budgetId,
  month,
  maxMonths,
  categoryId,
}: {
  budgetId: string;
  month: string;
  maxMonths: number;
  categoryId: string;
}): Promise<number> {
  assertCategoryOwner(budgetId, categoryId);
  const months = await getAverageMonths({
    budgetId,
    month,
    maxMonths,
    categoryId,
  });
  if (months.length === 0) {
    return 0;
  }

  let sumAmount = 0;
  for (const prevMonth of months) {
    sumAmount += await getSheetValue(
      monthUtils.sheetForMonth(budgetId, prevMonth),
      'sum-amount-' + categoryId,
    );
  }
  return Math.round(sumAmount / months.length);
}

async function getAverageMonths({
  budgetId,
  month,
  maxMonths,
  categoryId,
}: {
  budgetId: string;
  month: string;
  maxMonths: number;
  categoryId: string;
}): Promise<string[]> {
  const firstMonth = getAverageStartMonth(month);
  const firstActivityMonth = await getFirstActivityMonth({
    budgetId,
    categoryId,
    endMonth: firstMonth,
  });
  const months: string[] = [];
  let prevMonth = firstMonth;

  for (let l = 0; l < maxMonths; l++) {
    if (firstActivityMonth != null && prevMonth < firstActivityMonth) {
      break;
    }

    months.push(prevMonth);
    prevMonth = monthUtils.prevMonth(prevMonth);
  }

  return months;
}

function getAverageStartMonth(month: string): string {
  const prevMonth = monthUtils.prevMonth(month);

  if (prevMonth >= monthUtils.currentMonth()) {
    return monthUtils.prevMonth(monthUtils.currentMonth());
  }

  return prevMonth;
}

async function getFirstActivityMonth({
  budgetId,
  categoryId,
  endMonth,
}: {
  budgetId: string;
  categoryId: string;
  endMonth: string;
}): Promise<string | null> {
  const table = getBudgetTable(budgetId);
  const endDbMonth = dbMonth(endMonth);
  const firstActivity = await db.first<{ month: number | null }>(
    `SELECT MIN(month) AS month
       FROM (
         SELECT month
           FROM ${table}
          WHERE category = ? AND month <= ? AND budget_id = ?
         UNION ALL
         SELECT CAST(t.date / 100 AS INTEGER) AS month
           FROM v_transactions_internal_alive t
           LEFT JOIN accounts a ON a.id = t.account
          WHERE t.category = ?
            AND CAST(t.date / 100 AS INTEGER) <= ?
            AND a.offbudget = 0 AND a.budget_id = ?
       )`,
    [categoryId, endDbMonth, budgetId, categoryId, endDbMonth, budgetId],
  );

  return firstActivity?.month == null
    ? null
    : monthFromDbMonth(firstActivity.month);
}

export async function holdForNextMonth({
  budgetId,
  month,
  amount,
}: {
  budgetId: string;
  month: string;
  amount: number;
}): Promise<boolean> {
  getBudgetTable(budgetId);
  const row = await db.first<Pick<db.DbZeroBudgetMonth, 'buffered'>>(
    'SELECT buffered FROM zero_budget_months WHERE id = ? AND budget_id = ?',
    [budgetMonthId(budgetId, month), budgetId],
  );

  const sheetName = monthUtils.sheetForMonth(budgetId, month);
  const toBudget = await getSheetValue(sheetName, 'to-budget');

  if (toBudget > 0) {
    const bufferedAmount = calcBufferedAmount(
      toBudget,
      (row && row.buffered) || 0,
      amount,
    );

    await setBuffer(budgetId, month, bufferedAmount);
    return true;
  }
  return false;
}

export async function resetHold({
  budgetId,
  month,
}: {
  budgetId: string;
  month: string;
}): Promise<void> {
  await setBuffer(budgetId, month, 0);
}

export async function coverOverspending({
  budgetId,
  month,
  to,
  from,
  amount,
  currencyCode,
}: {
  budgetId: string;
  month: string;
  to: CategoryEntity['id'] | 'to-budget';
  from: CategoryEntity['id'] | 'to-budget' | 'overbudgeted';
  amount?: IntegerAmount;
  currencyCode: string;
}): Promise<void> {
  if (to !== 'to-budget') assertCategoryOwner(budgetId, to);
  if (from !== 'to-budget' && from !== 'overbudgeted') {
    assertCategoryOwner(budgetId, from);
  }
  const sheetName = monthUtils.sheetForMonth(budgetId, month);
  const toBudgeted = await getSheetValue(sheetName, 'budget-' + to);
  const leftoverFrom = await getSheetValue(
    sheetName,
    from === 'to-budget' ? 'to-budget' : 'leftover-' + from,
  );

  // Cover provided amount (can be partial) or full overspending amount.
  const amountToCover = amount
    ? // Covering in the app provides a positive amount to cover so we invert it here
      -amount
    : await getSheetValue(sheetName, 'leftover-' + to);

  if (amountToCover >= 0 || leftoverFrom <= 0) {
    return;
  }

  // Don't go over the leftover amount of the covering category
  const coverableAmount = Math.min(Math.abs(amountToCover), leftoverFrom);

  await batchMessages(async () => {
    // If we are covering it from the to be budgeted amount, ignore this
    if (from !== 'to-budget') {
      const fromBudgeted = await getSheetValue(sheetName, 'budget-' + from);
      await setBudget({
        budgetId,
        category: from,
        month,
        amount: fromBudgeted - coverableAmount,
      });
    }

    await setBudget({
      budgetId,
      category: to,
      month,
      amount: toBudgeted + coverableAmount,
    });

    await addMovementNotes({
      budgetId,
      month,
      amount: coverableAmount,
      to,
      from,
      currencyCode,
    });
  });
}

export async function transferAvailable({
  budgetId,
  month,
  amount,
  category,
}: {
  budgetId: string;
  month: string;
  amount: number;
  category: string;
}): Promise<void> {
  assertCategoryOwner(budgetId, category);
  const sheetName = monthUtils.sheetForMonth(budgetId, month);
  const leftover = await getSheetValue(sheetName, 'to-budget');
  amount = Math.max(Math.min(amount, leftover), 0);

  const budgeted = await getSheetValue(sheetName, 'budget-' + category);
  await setBudget({ budgetId, category, month, amount: budgeted + amount });
}

export async function coverOverbudgeted({
  budgetId,
  month,
  category,
  amount,
  currencyCode,
}: {
  budgetId: string;
  month: string;
  category: string;
  amount?: IntegerAmount;
  currencyCode: string;
}): Promise<void> {
  assertCategoryOwner(budgetId, category);
  const sheetName = monthUtils.sheetForMonth(budgetId, month);
  const categoryBudget = await getSheetValue(sheetName, 'budget-' + category);
  const categoryLeftover = await getSheetValue(
    sheetName,
    'leftover-' + category,
  );

  // Cover provided amount (can be partial) or full overbudgeted amount.
  const amountToCover = amount
    ? // Covering in the app provides a positive amount to cover so we invert it here
      -amount
    : await getSheetValue(sheetName, 'to-budget');

  if (amountToCover >= 0 || categoryLeftover <= 0) {
    return;
  }

  // Don't exceed the available balance of the covering category.
  const coverableAmount = Math.min(Math.abs(amountToCover), categoryLeftover);

  await batchMessages(async () => {
    await setBudget({
      budgetId,
      category,
      month,
      amount: categoryBudget - coverableAmount,
    });

    await addMovementNotes({
      budgetId,
      month,
      amount: coverableAmount,
      from: category,
      to: 'overbudgeted',
      currencyCode,
    });
  });
}

export async function transferCategory({
  budgetId,
  month,
  amount,
  from,
  to,
  currencyCode,
}: {
  budgetId: string;
  month: string;
  amount: number;
  to: CategoryEntity['id'] | 'to-budget';
  from: CategoryEntity['id'] | 'to-budget';
  currencyCode: string;
}): Promise<void> {
  if (from !== 'to-budget') assertCategoryOwner(budgetId, from);
  if (to !== 'to-budget') assertCategoryOwner(budgetId, to);
  const sheetName = monthUtils.sheetForMonth(budgetId, month);
  const fromBudgeted = await getSheetValue(sheetName, 'budget-' + from);

  await batchMessages(async () => {
    if (from !== 'to-budget') {
      await setBudget({
        budgetId,
        category: from,
        month,
        amount: fromBudgeted - amount,
      });
    }

    // If we are simply moving it back into available cash to budget,
    // don't do anything else
    if (to !== 'to-budget') {
      const toBudgeted = await getSheetValue(sheetName, 'budget-' + to);
      await setBudget({
        budgetId,
        category: to,
        month,
        amount: toBudgeted + amount,
      });
    }

    await addMovementNotes({
      budgetId,
      month,
      amount,
      to,
      from,
      currencyCode,
    });
  });
}

export async function copyUntilYearEnd({
  budgetId,
  month,
  category,
}: {
  budgetId: string;
  month: string;
  category: string;
}): Promise<void> {
  assertCategoryOwner(budgetId, category);
  const amount = await getSheetValue(
    monthUtils.sheetForMonth(budgetId, month),
    'budget-' + category,
  );

  const yearEnd = monthUtils.getYearEnd(month);
  const { createdMonths } = sheet.get().getBudgetMeta(budgetId);
  const futureMonths = [...createdMonths]
    .filter(m => m > month && m <= yearEnd)
    .sort();

  await batchMessages(async () => {
    for (const futureMonth of futureMonths) {
      void setBudget({ budgetId, category, month: futureMonth, amount });
    }
  });
}

export async function setCategoryCarryover({
  budgetId,
  startMonth,
  category,
  flag,
}: {
  budgetId: string;
  startMonth: string;
  category: string;
  flag: boolean;
}): Promise<void> {
  assertCategoryOwner(budgetId, category);
  const table = getBudgetTable(budgetId);
  const months = getAllMonths(budgetId, startMonth);

  await batchMessages(async () => {
    for (const month of months) {
      void setCarryover(
        budgetId,
        table,
        category,
        dbMonth(month).toString(),
        flag,
      );
    }
  });
}

function addNewLine(notes?: string) {
  return !notes ? '' : `${notes}\n`;
}

async function addMovementNotes({
  budgetId,
  month,
  amount,
  to,
  from,
  currencyCode,
}: {
  budgetId: string;
  month: string;
  amount: number;
  to: CategoryEntity['id'] | 'to-budget' | 'overbudgeted';
  from: CategoryEntity['id'] | 'to-budget';
  currencyCode: string;
}) {
  const currency = getCurrency(currencyCode);
  const displayAmount = integerToCurrency(
    amount,
    undefined,
    currency.decimalPlaces,
  );

  const monthBudgetNotesId =
    budgetId === DEFAULT_BUDGET_ID
      ? `budget-${month}`
      : `budget-${budgetId}-${month}`;
  const existingMonthBudgetNotes = addNewLine(
    db.firstSync<Pick<db.DbNote, 'note'>>(
      `SELECT n.note FROM notes n WHERE n.id = ?`,
      [monthBudgetNotesId],
    )?.note,
  );

  const locale = getLocale(await asyncStorage.getItem('language'));
  const displayDay = monthUtils.format(
    monthUtils.currentDate(),
    'MMMM dd',
    locale,
  );
  const categories = await db.getCategories(
    [from, to].filter(c => c !== 'to-budget' && c !== 'overbudgeted'),
  );

  const fromCategoryName =
    from === 'to-budget'
      ? 'To Budget'
      : categories.find(c => c.id === from)?.name;

  const toCategoryName =
    to === 'to-budget'
      ? 'To Budget'
      : to === 'overbudgeted'
        ? 'Overbudgeted'
        : categories.find(c => c.id === to)?.name;

  const note = `Reassigned ${displayAmount} from ${fromCategoryName} → ${toCategoryName} on ${displayDay}`;

  await db.update('notes', {
    id: monthBudgetNotesId,
    note: `${existingMonthBudgetNotes}- ${note}`,
  });
}

export async function resetIncomeCarryover({
  budgetId,
  month,
}: {
  budgetId: string;
  month: string;
}): Promise<void> {
  const table = getBudgetTable(budgetId);
  const categories = await db.all<db.DbViewCategory>(
    'SELECT * FROM v_categories WHERE is_income = 1 AND tombstone = 0 AND budget_id = ?',
    [budgetId],
  );

  await batchMessages(async () => {
    for (const category of categories) {
      await setCarryover(
        budgetId,
        table,
        category.id,
        dbMonth(month).toString(),
        false,
      );
    }
  });
}
