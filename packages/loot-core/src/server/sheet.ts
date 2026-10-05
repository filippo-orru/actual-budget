// @ts-strict-ignore
import type { Database } from '@jlongster/sql.js';

import { captureBreadcrumb } from '#platform/exceptions';
import { logger } from '#platform/server/log';
import * as sqlite from '#platform/server/sqlite';
import { sheetForMonth } from '#shared/months';
import * as Platform from '#shared/platform';

import type * as DbModule from './db';
import type { DbReflectBudget, DbZeroBudget, DbZeroBudgetMonth } from './db';
import { Spreadsheet } from './spreadsheet/spreadsheet';
import { resolveName } from './spreadsheet/util';

let globalSheet: Spreadsheet;
let globalOnChange;
let globalCacheDb;

export function get(): Spreadsheet {
  return globalSheet;
}

async function updateSpreadsheetCache(rawDb, names: string[]) {
  sqlite.transaction(rawDb, () => {
    names.forEach(name => {
      const node = globalSheet._getNode(name);

      // Don't cache query nodes yet
      if (node.sql == null) {
        sqlite.runQuery(
          rawDb,
          'INSERT OR REPLACE INTO kvcache (key, value) VALUES (?, ?)',
          [name, JSON.stringify(node.value)],
        );
      }
    });
  });
}

function setCacheStatus(
  mainDb: Database,
  cacheDb: Database,
  { clean }: { clean: boolean },
) {
  if (clean) {
    // Generate random number and stick in both places
    const num = Math.random() * 10000000;
    sqlite.runQuery(
      cacheDb,
      'INSERT OR REPLACE INTO kvcache_key (id, key) VALUES (1, ?)',
      [num],
    );

    if (mainDb) {
      sqlite.runQuery(
        mainDb,
        'INSERT OR REPLACE INTO kvcache_key (id, key) VALUES (1, ?)',
        [num],
      );
    }
  } else {
    sqlite.runQuery(cacheDb, 'DELETE FROM kvcache_key');
  }
}

function isCacheDirty(mainDb: Database, cacheDb: Database): boolean {
  let rows = sqlite.runQuery<{ key?: number }>(
    cacheDb,
    'SELECT key FROM kvcache_key WHERE id = 1',
    [],
    true,
  );
  const num = rows.length === 0 ? null : rows[0].key;

  if (num == null) {
    return true;
  }

  if (mainDb) {
    const rows = sqlite.runQuery<{ key?: number }>(
      mainDb,
      'SELECT key FROM kvcache_key WHERE id = 1',
      [],
      true,
    );
    if (rows.length === 0 || rows[0].key !== num) {
      return true;
    }
  }

  // Always also check if there is anything in `kvcache`. We ask for one item;
  // if we didn't get back anything it's empty so there is no cache
  rows = sqlite.runQuery(cacheDb, 'SELECT * FROM kvcache LIMIT 1', [], true);
  return rows.length === 0;
}

export async function loadSpreadsheet(
  db,
  onSheetChange?,
): Promise<Spreadsheet> {
  const cacheEnabled = process.env.NODE_ENV !== 'test';
  const mainDb = db.getDatabase();
  let cacheDb;

  if (!Platform.isBrowser && cacheEnabled) {
    // Desktop apps use a separate database for the cache. This is because it is
    // much more likely to directly work with files on desktop, and this makes
    // it a lot clearer what the true filesize of the main db is (and avoid
    // copying the cache data around).
    const cachePath = db
      .getDatabasePath()
      .replace(/db\.sqlite$/, 'cache.sqlite');
    globalCacheDb = cacheDb = await sqlite.openDatabase(cachePath);

    sqlite.execQuery(
      cacheDb,
      `
        CREATE TABLE IF NOT EXISTS kvcache (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS kvcache_key (id INTEGER PRIMARY KEY, key REAL)
      `,
    );
  } else {
    // All other platforms use the same database for cache
    cacheDb = mainDb;
  }

  let sheet;
  if (cacheEnabled) {
    sheet = new Spreadsheet(
      updateSpreadsheetCache.bind(null, cacheDb),
      setCacheStatus.bind(null, mainDb, cacheDb),
    );
  } else {
    sheet = new Spreadsheet();
  }

  // Old caches used file-global month sheets. Never restore those cells into
  // the namespaced engine, but leave all database financial rows untouched.
  sqlite.runQuery(
    cacheDb,
    "DELETE FROM kvcache WHERE key GLOB 'budget[0-9][0-9][0-9][0-9][0-9][0-9]!*'",
    [],
  );

  captureBreadcrumb({
    message: 'loading spreadsheet',
    category: 'server',
  });

  globalSheet = sheet;
  globalOnChange = onSheetChange;

  if (onSheetChange) {
    sheet.addEventListener('change', onSheetChange);
  }

  if (cacheEnabled && !isCacheDirty(mainDb, cacheDb)) {
    const cachedRows = sqlite.runQuery<{ key?: number; value: string }>(
      cacheDb,
      'SELECT * FROM kvcache',
      [],
      true,
    );
    logger.log(`Loaded spreadsheet from cache (${cachedRows.length} items)`);

    for (const row of cachedRows) {
      const parsed = JSON.parse(row.value);
      sheet.load(row.key, parsed);
    }
  } else {
    logger.log('Loading fresh spreadsheet');
    await loadUserBudgets(db);
  }

  captureBreadcrumb({
    message: 'loaded spreadsheet',
    category: 'server',
  });

  return sheet;
}

export function unloadSpreadsheet(): void {
  if (globalSheet) {
    // TODO: Should wait for the sheet to finish
    globalSheet.unload();
    globalSheet = null;
  }

  if (globalCacheDb) {
    sqlite.closeDatabase(globalCacheDb);
    globalCacheDb = null;
  }
}

export async function reloadSpreadsheet(db): Promise<Spreadsheet> {
  if (globalSheet) {
    unloadSpreadsheet();
    return loadSpreadsheet(db, globalOnChange);
  }
}

export async function loadUserBudgets(
  db: typeof DbModule,
  budgetId?: string,
): Promise<void> {
  const sheet = globalSheet;
  const budgetSpaces = await db.all<{ id: string; budget_type: string }>(
    `SELECT id, budget_type FROM budgets WHERE tombstone = 0${budgetId ? ' AND id = ?' : ''}`,
    budgetId ? [budgetId] : [],
  );

  sheet.startTransaction();

  for (const budgetSpace of budgetSpaces) {
    if (
      budgetSpace.budget_type !== 'envelope' &&
      budgetSpace.budget_type !== 'tracking'
    ) {
      throw new Error(
        `Unknown budget type for ${budgetSpace.id}: ${budgetSpace.budget_type}`,
      );
    }
    const table =
      budgetSpace.budget_type === 'tracking'
        ? 'reflect_budgets'
        : 'zero_budgets';
    const budgets = await db.all<DbReflectBudget | DbZeroBudget>(
      `SELECT b.* FROM ${table} b JOIN categories c ON c.id = b.category
       WHERE c.tombstone = 0 AND c.budget_id = ? AND b.budget_id = ?`,
      [budgetSpace.id, budgetSpace.id],
    );
    for (const budget of budgets) {
      if (!budget.month || !budget.category) continue;
      const monthNumber = String(budget.month).padStart(6, '0');
      const month = `${monthNumber.slice(0, 4)}-${monthNumber.slice(4)}`;
      const sheetName = sheetForMonth(budgetSpace.id, month);
      sheet.set(`${sheetName}!budget-${budget.category}`, budget.amount);
      sheet.set(
        `${sheetName}!carryover-${budget.category}`,
        budget.carryover === 1,
      );
      sheet.set(`${sheetName}!goal-${budget.category}`, budget.goal);
      sheet.set(`${sheetName}!long-goal-${budget.category}`, budget.long_goal);
    }

    if (budgetSpace.budget_type !== 'tracking') {
      const budgetMonths = await db.all<DbZeroBudgetMonth>(
        'SELECT * FROM zero_budget_months WHERE budget_id = ?',
        [budgetSpace.id],
      );
      for (const budgetMonth of budgetMonths) {
        if (!budgetMonth.month) continue;
        const sheetName = sheetForMonth(budgetSpace.id, budgetMonth.month);
        sheet.set(`${sheetName}!buffered`, budgetMonth.buffered);
      }
    }
  }

  sheet.endTransaction();
}

export function getCell(sheet: string, name: string) {
  return globalSheet._getNode(resolveName(sheet, name));
}

export function getCellValue(
  sheet: string,
  name: string,
): string | number | boolean {
  return globalSheet.getValue(resolveName(sheet, name));
}

export function startTransaction(): void {
  if (globalSheet) {
    globalSheet.startTransaction();
  }
}

export function endTransaction(): void {
  if (globalSheet) {
    globalSheet.endTransaction();
  }
}

export function waitOnSpreadsheet(): Promise<void> {
  return new Promise(resolve => {
    if (globalSheet) {
      globalSheet.onFinish(resolve);
    } else {
      resolve(undefined);
    }
  });
}
