import * as nativeFs from 'fs';
import * as path from 'path';

import type { Database } from '@jlongster/sql.js';
import { describe, expect, it } from 'vitest';

import * as sqlite from '#platform/server/sqlite';

import {
  applyMigration,
  getMigrationId,
  getMigrationList,
  migrate,
} from './migrations';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');
const INIT_SQL = path.resolve(__dirname, '../sql/init.sql');
const BUDGET_SPACES_MIGRATION = '1791082200000_add_budget_spaces.sql';

async function openMasterSchemaDb(): Promise<Database> {
  await sqlite.init();
  const db = await sqlite.openDatabase(':memory:');
  sqlite.execQuery(db, nativeFs.readFileSync(INIT_SQL, 'utf8'));

  const migrations = await getMigrationList(MIGRATIONS_DIR);
  for (const name of migrations) {
    if (getMigrationId(name) >= getMigrationId(BUDGET_SPACES_MIGRATION)) {
      break;
    }
    await applyMigration(db, name, MIGRATIONS_DIR);
  }

  return db;
}

function insertMasterData(db: Database) {
  sqlite.execQuery(
    db,
    `
      INSERT INTO preferences (id, value) VALUES
        ('defaultCurrencyCode', 'CAD'),
        ('budgetType', 'tracking');

      INSERT INTO banks (id, bank_id, name, tombstone)
        VALUES ('bank-1', 'bank-external-1', 'Old bank', 1);
      INSERT INTO account_groups (id, name, sort_order, tombstone)
        VALUES ('group-1', 'Archived group', 4, 1);
      INSERT INTO accounts (id, name, closed, offbudget, tombstone, balance_current, account_group_id, bank)
        VALUES ('account-1', 'Closed account', 1, 1, 1, 4321, 'group-1', 'bank-1');
      INSERT INTO category_groups (id, name, is_income, sort_order, hidden, tombstone)
        VALUES ('category-group-1', 'Hidden group', 0, 7, 1, 1);
      INSERT INTO categories (id, name, is_income, cat_group, sort_order, hidden, tombstone)
        VALUES ('category-1', 'Hidden category', 0, 'category-group-1', 9, 1, 1);
      INSERT INTO category_mapping (id, transferId)
        VALUES ('category-1', 'category-1');
      INSERT INTO cleanup_groups (id, name, tombstone)
        VALUES ('cleanup-1', 'Old cleanup', 1);
      INSERT INTO rules (id, stage, conditions, actions, tombstone, conditions_op)
        VALUES ('rule-1', 'payee', '[]', '[]', 1, 'and');
      INSERT INTO schedules (id, rule, name, active, completed, posts_transaction, tombstone, sort_order)
        VALUES ('schedule-1', 'rule-1', 'Old schedule', 0, 1, 0, 1, 3);
      INSERT INTO transaction_filters (id, name, conditions, conditions_op, tombstone)
        VALUES ('filter-1', 'Old filter', '[]', 'and', 1);
      INSERT INTO custom_reports (id, name, start_date, end_date, tombstone)
        VALUES ('report-1', 'Old report', '2020-01', '2020-12', 1);
      INSERT INTO dashboard_pages (id, name, tombstone)
        VALUES ('dashboard-page-1', 'Old dashboard', 1);
      INSERT INTO dashboard (id, type, width, height, x, y, dashboard_page_id, tombstone)
        VALUES ('widget-1', 'net-worth-card', 8, 2, 0, 0, 'dashboard-page-1', 1);
      INSERT INTO transactions (id, acct, category, amount, date, tombstone, reconciled)
        VALUES ('transaction-1', 'account-1', 'category-1', -9876, 20240203, 1, 1);
      INSERT INTO zero_budgets (id, month, category, amount, carryover)
        VALUES ('2024-02-category-1', 202402, 'category-1', -123, 1);
      INSERT INTO reflect_budgets (id, month, category, amount, carryover)
        VALUES ('2024-02-category-1', 202402, 'category-1', 456, 0);
      INSERT INTO zero_budget_months (id, buffered)
        VALUES ('2024-02', 789);
      INSERT INTO notes (id, note)
        VALUES ('transaction-1', 'Historical note');
    `,
  );
}

function rows<T>(db: Database, query: string): T[] {
  return sqlite.runQuery<T>(db, query, [], true);
}

async function upgrade(db: Database) {
  await applyMigration(db, BUDGET_SPACES_MIGRATION, MIGRATIONS_DIR);
}

describe('default budget migration', () => {
  it('preserves master financial data and assigns all owned history to default', async () => {
    const db = await openMasterSchemaDb();
    insertMasterData(db);

    await upgrade(db);

    expect(rows(db, 'SELECT * FROM budgets')).toEqual([
      {
        id: 'default',
        name: 'Main',
        currency_code: 'CAD',
        budget_type: 'tracking',
        sort_order: 0,
        tombstone: 0,
      },
    ]);
    expect(rows(db, 'SELECT id, budget_id FROM accounts')).toEqual([
      { id: 'account-1', budget_id: 'default' },
    ]);

    const ownedTables = [
      'account_groups',
      'categories',
      'category_groups',
      'cleanup_groups',
      'rules',
      'schedules',
      'transaction_filters',
      'custom_reports',
      'dashboard_pages',
      'zero_budgets',
      'reflect_budgets',
      'zero_budget_months',
    ];
    for (const table of ownedTables) {
      expect(rows(db, `SELECT DISTINCT budget_id FROM ${table}`)).toEqual([
        { budget_id: 'default' },
      ]);
    }

    expect(
      rows(
        db,
        'SELECT id, name, closed, offbudget, tombstone, balance_current, account_group_id, bank FROM accounts',
      ),
    ).toEqual([
      {
        id: 'account-1',
        name: 'Closed account',
        closed: 1,
        offbudget: 1,
        tombstone: 1,
        balance_current: 4321,
        account_group_id: 'group-1',
        bank: 'bank-1',
      },
    ]);
    expect(rows(db, 'SELECT id, bank_id, name, tombstone FROM banks')).toEqual([
      {
        id: 'bank-1',
        bank_id: 'bank-external-1',
        name: 'Old bank',
        tombstone: 1,
      },
    ]);
    expect(rows(db, 'SELECT id, transferId FROM category_mapping')).toEqual([
      { id: 'category-1', transferId: 'category-1' },
    ]);
    expect(rows(db, 'SELECT id, note FROM notes')).toEqual([
      { id: 'transaction-1', note: 'Historical note' },
    ]);
    expect(
      rows(
        db,
        'SELECT id, acct, category, amount, date, tombstone, reconciled FROM transactions',
      ),
    ).toEqual([
      {
        id: 'transaction-1',
        acct: 'account-1',
        category: 'category-1',
        amount: -9876,
        date: 20240203,
        tombstone: 1,
        reconciled: 1,
      },
    ]);
    expect(
      rows(
        db,
        'SELECT id, month, category, amount, carryover FROM zero_budgets',
      ),
    ).toEqual([
      {
        id: '2024-02-category-1',
        month: 202402,
        category: 'category-1',
        amount: -123,
        carryover: 1,
      },
    ]);
    expect(
      rows(db, 'SELECT id, month, buffered FROM zero_budget_months'),
    ).toEqual([{ id: '2024-02', month: '2024-02', buffered: 789 }]);
    expect(
      rows(
        db,
        "SELECT id, dashboard_page_id FROM dashboard WHERE id = 'widget-1'",
      ),
    ).toEqual([{ id: 'widget-1', dashboard_page_id: 'dashboard-page-1' }]);

    sqlite.closeDatabase(db);
  });

  it('assigns the same deterministic default ID to identical snapshots', async () => {
    const first = await openMasterSchemaDb();
    const second = await openMasterSchemaDb();
    insertMasterData(first);
    insertMasterData(second);

    await upgrade(first);
    await upgrade(second);

    expect(rows(first, 'SELECT id FROM budgets')).toEqual([{ id: 'default' }]);
    expect(rows(second, 'SELECT id FROM budgets')).toEqual([{ id: 'default' }]);
    expect(rows(first, 'SELECT id FROM budgets')).toEqual(
      rows(second, 'SELECT id FROM budgets'),
    );

    sqlite.closeDatabase(first);
    sqlite.closeDatabase(second);
  });

  it('is safe to load repeatedly and falls back for absent currency and type preferences', async () => {
    const db = await openMasterSchemaDb();
    await migrate(db);
    await migrate(db);

    expect(
      rows(db, 'SELECT id, name, currency_code, budget_type FROM budgets'),
    ).toEqual([
      {
        id: 'default',
        name: 'Main',
        currency_code: '',
        budget_type: 'envelope',
      },
    ]);
    expect(rows(db, 'SELECT id FROM budgets')).toEqual([{ id: 'default' }]);

    sqlite.closeDatabase(db);
  });
});
