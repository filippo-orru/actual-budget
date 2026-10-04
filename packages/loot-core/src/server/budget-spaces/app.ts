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

export type BudgetSpaceHandlers = {
  'budget-spaces/get': typeof getBudgetSpaces;
  'budget-spaces/create': typeof createBudgetSpace;
  'budget-spaces/update': typeof updateBudgetSpace;
};

export const app = createApp<BudgetSpaceHandlers>();
app.method('budget-spaces/get', getBudgetSpaces);
app.method('budget-spaces/create', mutator(undoable(createBudgetSpace)));
app.method('budget-spaces/update', mutator(undoable(updateBudgetSpace)));

async function getBudgetSpaces(): Promise<BudgetSpaceEntity[]> {
  return (await getBudgetSpaceRows()).map(row => budgetSpaceModel.fromDb(row));
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ValidationError('Budget name must not be empty');
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
  const multiBudgetFlag = await db.first<Pick<db.DbPreference, 'value'>>(
    'SELECT value FROM preferences WHERE id = ?',
    ['flags.multiCurrency'],
  );
  if (multiBudgetFlag?.value !== 'true') {
    throw new ValidationError('Creating additional budgets is disabled');
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
    await db.insertCategory({
      budget_id: id,
      name: 'Starting Balances',
      cat_group: incomeGroupId,
      is_income: 1,
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
    updates.currency_code = validateCurrencyCode(args.currencyCode);
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
