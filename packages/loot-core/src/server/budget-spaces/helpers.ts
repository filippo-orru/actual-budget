import * as db from '#server/db';
import type { DbBudgetSpace } from '#server/db';
import { ValidationError } from '#server/errors';
import { getCurrency } from '#shared/currencies';

export type BudgetOwnedTable =
  | 'accounts'
  | 'account_groups'
  | 'categories'
  | 'category_groups'
  | 'cleanup_groups'
  | 'rules'
  | 'schedules'
  | 'transaction_filters'
  | 'custom_reports'
  | 'dashboard_pages'
  | 'zero_budgets'
  | 'reflect_budgets'
  | 'zero_budget_months';

/** Note IDs encode several entity and month forms, so validate the referenced entity instead. */
type DerivedBudgetTable =
  | 'transactions'
  | 'dashboard'
  | 'category_mapping'
  | 'schedules_next_date';

export type BudgetEntityReference =
  | { table: BudgetOwnedTable; id: string }
  | { table: DerivedBudgetTable; id: string };

export async function getBudgetSpaces(): Promise<DbBudgetSpace[]> {
  return db.all<DbBudgetSpace>(
    'SELECT * FROM budgets WHERE tombstone = 0 ORDER BY sort_order, id',
  );
}

export async function validateBudgetExists(budgetId: string) {
  const budget = await db.first<Pick<DbBudgetSpace, 'id'>>(
    'SELECT id FROM budgets WHERE id = ? AND tombstone = 0',
    [budgetId],
  );
  if (!budget) {
    throw new ValidationError(`Budget not found: ${budgetId}`);
  }
  return budget.id;
}

export async function getBudgetDecimalPlaces(
  budgetId: string,
): Promise<number> {
  await validateBudgetExists(budgetId);
  const [budget, currencyFlag] = await Promise.all([
    db.first<Pick<DbBudgetSpace, 'currency_code'>>(
      'SELECT currency_code FROM budgets WHERE id = ?',
      [budgetId],
    ),
    db.first<{ value: string }>(
      "SELECT value FROM preferences WHERE id = 'flags.currency'",
    ),
  ]);
  return currencyFlag?.value === 'true' && budget?.currency_code
    ? getCurrency(budget.currency_code).decimalPlaces
    : 2;
}

export async function resolveBudgetId(budgetId?: string): Promise<string> {
  if (budgetId !== undefined) {
    return validateBudgetExists(budgetId);
  }

  const budgets = await getBudgetSpaces();
  if (budgets.length === 1) {
    return budgets[0].id;
  }
  if (budgets.length === 0) {
    throw new ValidationError('No active budget exists in this file');
  }
  throw new ValidationError(
    'budgetId is required when a file contains multiple budgets',
  );
}

export async function getBudgetIdForEntity({
  table,
  id,
}: BudgetEntityReference): Promise<string> {
  let row: { budget_id: string } | null;
  switch (table) {
    case 'transactions':
      row = await db.first<{ budget_id: string }>(
        `SELECT a.budget_id FROM transactions t
         JOIN accounts a ON a.id = t.acct WHERE t.id = ?`,
        [id],
      );
      break;
    case 'dashboard':
      row = await db.first<{ budget_id: string }>(
        `SELECT p.budget_id FROM dashboard d
         JOIN dashboard_pages p ON p.id = d.dashboard_page_id WHERE d.id = ?`,
        [id],
      );
      break;
    case 'category_mapping':
      row = await db.first<{ budget_id: string }>(
        'SELECT budget_id FROM categories WHERE id = ?',
        [id],
      );
      break;
    case 'schedules_next_date':
      row = await db.first<{ budget_id: string }>(
        `SELECT s.budget_id FROM schedules_next_date n
         JOIN schedules s ON s.id = n.schedule_id WHERE n.id = ?`,
        [id],
      );
      break;
    default:
      row = await db.first<{ budget_id: string }>(
        `SELECT budget_id FROM ${table} WHERE id = ?`,
        [id],
      );
      break;
  }

  if (!row) {
    throw new ValidationError(`${table} entity not found: ${id}`);
  }
  await validateBudgetExists(row.budget_id);
  return row.budget_id;
}

export async function assertSameBudgetOwner(
  references: BudgetEntityReference[],
): Promise<string> {
  if (references.length === 0) {
    throw new ValidationError('At least one budget-owned entity is required');
  }

  const budgetIds = await Promise.all(references.map(getBudgetIdForEntity));
  const [budgetId, ...otherBudgetIds] = budgetIds;
  if (otherBudgetIds.some(otherId => otherId !== budgetId)) {
    throw new ValidationError('Entities must belong to the same budget');
  }
  return budgetId;
}

export async function assertBudgetOwner(
  budgetId: string,
  references: BudgetEntityReference[],
): Promise<void> {
  await validateBudgetExists(budgetId);
  const ownerId = await assertSameBudgetOwner(references);
  if (ownerId !== budgetId) {
    throw new ValidationError('Entity does not belong to the requested budget');
  }
}
