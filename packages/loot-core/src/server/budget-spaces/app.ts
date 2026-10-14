import { v4 as uuidv4 } from 'uuid';

import { createApp } from '#server/app';
import * as db from '#server/db';
import { SORT_INCREMENT } from '#server/db/sort';
import { ValidationError } from '#server/errors';
import { budgetSpaceModel } from '#server/models';
import { mutator } from '#server/mutators';
import { batchMessages } from '#server/sync';
import { undoable } from '#server/undo';
import { currencies } from '#shared/currencies';
import { DEFAULT_DASHBOARD_STATE } from '#shared/dashboard';
import type { BudgetSpaceEntity } from '#types/models';

import {
  getBudgetSpaces as getBudgetSpaceRows,
  validateBudgetExists,
} from './helpers';

type CreateBudgetSpaceArgs = {
  name: string;
  currencyCode: string;
};

type UpdateBudgetSpaceArgs = {
  id: string;
  name?: string;
  currencyCode?: string;
  budgetType?: 'envelope' | 'tracking';
};

type DeleteBudgetSpaceArgs = { id: string };

export type BudgetSpaceHandlers = {
  'budget-spaces/get': typeof getBudgetSpaces;
  'budget-spaces/create': typeof createBudgetSpace;
  'budget-spaces/update': typeof updateBudgetSpace;
  'budget-spaces/delete': typeof deleteBudgetSpace;
};

export const app = createApp<BudgetSpaceHandlers>();
app.method('budget-spaces/get', getBudgetSpaces);
app.method('budget-spaces/create', mutator(undoable(createBudgetSpace)));
app.method('budget-spaces/update', mutator(undoable(updateBudgetSpace)));
app.method('budget-spaces/delete', mutator(undoable(deleteBudgetSpace)));

async function getBudgetSpaces(): Promise<BudgetSpaceEntity[]> {
  return (await getBudgetSpaceRows()).map(row => budgetSpaceModel.fromDb(row));
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('Budget space name must not be empty');
  }
  return name.trim();
}

function validateCurrencyCode(currencyCode: unknown): string {
  if (
    typeof currencyCode !== 'string' ||
    !currencies.some(currency => currency.code === currencyCode)
  ) {
    throw new ValidationError(`Unknown currency code: ${String(currencyCode)}`);
  }
  return currencyCode;
}

function rejectUnknownFields(args: object, allowedFields: string[]) {
  const unknownFields = Object.keys(args).filter(
    field => !allowedFields.includes(field),
  );
  if (unknownFields.length > 0) {
    throw new ValidationError(
      `Unexpected budget-space field: ${unknownFields.join(', ')}`,
    );
  }
}

async function createBudgetSpace(
  args: CreateBudgetSpaceArgs,
): Promise<BudgetSpaceEntity> {
  rejectUnknownFields(args, ['name', 'currencyCode']);
  const { name, currencyCode } = args;
  const normalizedName = validateName(name);
  const normalizedCurrencyCode = validateCurrencyCode(currencyCode);
  if (normalizedCurrencyCode === '') {
    throw new ValidationError(
      'A known currency is required to create a budget space',
    );
  }
  const multiBudgetFlag = await db.first<Pick<db.DbPreference, 'value'>>(
    'SELECT value FROM preferences WHERE id = ?',
    ['flags.multiCurrency'],
  );
  if (multiBudgetFlag?.value !== 'true') {
    throw new ValidationError('Creating additional budget spaces is disabled');
  }

  const existingBudgets = await db.all<Pick<db.DbBudgetSpace, 'currency_code'>>(
    'SELECT currency_code FROM budgets WHERE tombstone = 0',
  );
  if (
    existingBudgets.some(
      budget =>
        !budget.currency_code ||
        !currencies.some(currency => currency.code === budget.currency_code),
    )
  ) {
    throw new ValidationError(
      'Every existing budget space must have a known currency before creating another one',
    );
  }

  const lastBudget = await db.first<{ sort_order: number }>(
    'SELECT sort_order FROM budgets WHERE tombstone = 0 ORDER BY sort_order DESC, id DESC LIMIT 1',
  );
  const id = uuidv4();
  const budget: BudgetSpaceEntity = {
    id,
    name: normalizedName,
    currency_code: normalizedCurrencyCode,
    budget_type: 'envelope',
    sort_order: (lastBudget?.sort_order ?? 0) + SORT_INCREMENT,
    tombstone: false,
  };

  await batchMessages(async () => {
    await db.insertWithSchema('budgets', budget);

    const incomeGroupId = uuidv4();
    await db.insertWithSchema('category_groups', {
      id: incomeGroupId,
      budget_id: id,
      name: 'Income',
      is_income: true,
      sort_order: 0,
    });
    const startingBalancesId = uuidv4();
    await db.insertWithSchema('categories', {
      id: startingBalancesId,
      budget_id: id,
      name: 'Starting Balances',
      group: incomeGroupId,
      is_income: true,
      hidden: false,
      sort_order: 0,
    });
    await db.insert('category_mapping', {
      id: startingBalancesId,
      transferId: startingBalancesId,
    });

    await db.insertWithSchema('category_groups', {
      id: uuidv4(),
      budget_id: id,
      name: 'Expenses',
      is_income: false,
      sort_order: 0,
    });

    const dashboardPageId = uuidv4();
    await db.insertWithSchema('dashboard_pages', {
      id: dashboardPageId,
      budget_id: id,
      name: 'Main',
    });
    await Promise.all(
      DEFAULT_DASHBOARD_STATE.map(widget =>
        db.insertWithSchema('dashboard', {
          ...widget,
          dashboard_page_id: dashboardPageId,
        }),
      ),
    );
  });

  const createdBudget = await db.first<db.DbBudgetSpace>(
    'SELECT * FROM budgets WHERE id = ?',
    [id],
  );
  if (!createdBudget) {
    throw new Error(`Created budget space was not found: ${id}`);
  }
  return budgetSpaceModel.fromDb(createdBudget);
}

async function deleteBudgetSpace(args: DeleteBudgetSpaceArgs) {
  rejectUnknownFields(args, ['id']);
  const { id } = args;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ValidationError('Budget ID is required');
  }
  await validateBudgetExists(id);

  const activeBudgets = await db.first<{ count: number }>(
    'SELECT COUNT(*) AS count FROM budgets WHERE tombstone = 0',
  );
  if ((activeBudgets?.count ?? 0) <= 1) {
    throw new ValidationError('The last budget space cannot be deleted');
  }

  const ownedTables = [
    'accounts',
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
  ] as const;

  await batchMessages(async () => {
    const accountIds = await getIds('accounts', id);
    const categoryIds = await getIds('categories', id);
    const categoryGroupIds = await getIds('category_groups', id);
    const scheduleIds = await getIds('schedules', id);
    const dashboardPageIds = await getIds('dashboard_pages', id);

    await clearNotes([
      ...accountIds.map(accountId => `account-${accountId}`),
      ...categoryIds,
      ...categoryGroupIds,
    ]);
    await deleteRows('transactions', 'acct', accountIds);
    await deleteRows('dashboard', 'dashboard_page_id', dashboardPageIds);
    await deleteRows('schedules_next_date', 'schedule_id', scheduleIds);

    if (categoryIds.length > 0) {
      const placeholders = categoryIds.map(() => '?').join(', ');
      const mappings = await db.all<{ id: string }>(
        `SELECT id FROM category_mapping WHERE id IN (${placeholders})`,
        categoryIds,
      );
      await Promise.all(
        mappings.map(({ id: mappingId }) =>
          db.update('category_mapping', {
            id: mappingId,
            transferId: mappingId,
          }),
        ),
      );
    }

    // Payees and their mappings/locations are shared between budget spaces.
    // Leave transfer payees intact even when their linked account is deleted.

    for (const table of ownedTables) {
      await deleteRows(table, 'budget_id', [id]);
    }
    await db.delete_('budgets', id);
  });
}

async function getIds(
  table: (typeof ownedTablesForIds)[number],
  budgetId: string,
): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM ${table} WHERE budget_id = ?`,
    [budgetId],
  );
  return rows.map(({ id }) => id);
}

const ownedTablesForIds = [
  'accounts',
  'categories',
  'category_groups',
  'schedules',
  'dashboard_pages',
] as const;

async function clearNotes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  const notes = await db.all<{ id: string }>(
    `SELECT id FROM notes WHERE id IN (${placeholders})`,
    ids,
  );
  await Promise.all(
    notes.map(({ id }) => db.update('notes', { id, note: '' })),
  );
}

async function deleteRows(
  table: string,
  field: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db.all<{ id: string }>(
    `SELECT id FROM ${table} WHERE ${field} IN (${placeholders})`,
    ids,
  );
  await Promise.all(rows.map(({ id: rowId }) => db.delete_(table, rowId)));
}

async function updateBudgetSpace(args: UpdateBudgetSpaceArgs) {
  rejectUnknownFields(args, ['id', 'name', 'currencyCode', 'budgetType']);
  if (typeof args.id !== 'string' || args.id.length === 0) {
    throw new ValidationError('Budget ID is required');
  }
  await validateBudgetExists(args.id);

  const updates: Partial<
    Pick<BudgetSpaceEntity, 'name' | 'currency_code' | 'budget_type'>
  > = {};
  if (args.name !== undefined) {
    updates.name = validateName(args.name);
  }
  if (args.currencyCode !== undefined) {
    const currencyCode = validateCurrencyCode(args.currencyCode);
    if (currencyCode === '') {
      const budgetCount = await db.first<{ count: number }>(
        'SELECT COUNT(*) AS count FROM budgets WHERE tombstone = 0',
      );
      if ((budgetCount?.count ?? 0) > 1) {
        throw new ValidationError(
          'Budget space currency cannot be cleared while multiple budget spaces exist',
        );
      }
    }
    updates.currency_code = currencyCode;
  }
  if (args.budgetType !== undefined) {
    if (args.budgetType !== 'envelope' && args.budgetType !== 'tracking') {
      throw new ValidationError(
        `Unknown budget type: ${String(args.budgetType)}`,
      );
    }
    updates.budget_type = args.budgetType;
  }

  if (Object.keys(updates).length > 0) {
    await db.update('budgets', { id: args.id, ...updates });
  }

  const updatedBudget = await db.first<db.DbBudgetSpace>(
    'SELECT * FROM budgets WHERE id = ?',
    [args.id],
  );
  if (!updatedBudget) {
    throw new ValidationError(`Budget not found: ${args.id}`);
  }
  return budgetSpaceModel.fromDb(updatedBudget);
}
