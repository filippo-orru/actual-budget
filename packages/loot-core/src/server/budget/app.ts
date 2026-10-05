import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import {
  assertBudgetOwner,
  getBudgetIdForEntity,
  validateBudgetExists,
} from '#server/budget-spaces/helpers';
import * as db from '#server/db';
import { APIError } from '#server/errors';
import { categoryGroupModel, categoryModel } from '#server/models';
import { mutator } from '#server/mutators';
import * as sheet from '#server/sheet';
import { resolveName } from '#server/spreadsheet/util';
import { batchMessages } from '#server/sync';
import { undoable } from '#server/undo';
import * as monthUtils from '#shared/months';
import { q } from '#shared/query';
import type { CategoryEntity, CategoryGroupEntity } from '#types/models';

import * as actions from './actions';
import * as budget from './base';
import * as cleanupGroupActions from './cleanup-groups';
import * as cleanupActions from './cleanup-template';
import { storeNoteCleanups } from './cleanup-template-notes';
import * as goalActions from './goal-template';
import { sortCategories } from './sort-categories';
import * as goalNoteActions from './template-notes';

export type BudgetHandlers = {
  'budget/budget-amount': typeof actions.setBudget;
  'budget/copy-previous-month': typeof actions.copyPreviousMonth;
  'budget/copy-single-month': typeof actions.copySinglePreviousMonth;
  'budget/set-zero': typeof actions.setZero;
  'budget/set-3month-avg': typeof actions.set3MonthAvg;
  'budget/set-6month-avg': typeof actions.set6MonthAvg;
  'budget/set-12month-avg': typeof actions.set12MonthAvg;
  'budget/set-n-month-avg': typeof actions.setNMonthAvg;
  'budget/check-templates': typeof goalActions.runCheckTemplates;
  'budget/apply-goal-template': typeof goalActions.applyTemplate;
  'budget/apply-multiple-templates': typeof goalActions.applyMultipleCategoryTemplates;
  'budget/overwrite-goal-template': typeof goalActions.overwriteTemplate;
  'budget/apply-single-template': typeof goalActions.applySingleCategoryTemplate;
  'budget/cleanup-goal-template': typeof cleanupActions.cleanupTemplate;
  'budget/hold-for-next-month': typeof actions.holdForNextMonth;
  'budget/reset-hold': typeof actions.resetHold;
  'budget/cover-overspending': typeof actions.coverOverspending;
  'budget/transfer-available': typeof actions.transferAvailable;
  'budget/cover-overbudgeted': typeof actions.coverOverbudgeted;
  'budget/transfer-category': typeof actions.transferCategory;
  'budget/copy-until-year-end': typeof actions.copyUntilYearEnd;
  'budget/set-carryover': typeof actions.setCategoryCarryover;
  'budget/reset-income-carryover': typeof actions.resetIncomeCarryover;
  'get-categories': typeof getCategories;
  'get-budget-bounds': typeof getBudgetBounds;
  'envelope-budget-month': typeof envelopeBudgetMonth;
  'tracking-budget-month': typeof trackingBudgetMonth;
  'category-create': typeof createCategory;
  'category-update': typeof updateCategory;
  'category-move': typeof moveCategory;
  'categories-sort': typeof sortCategories;
  'category-delete': typeof deleteCategory;
  'get-category-groups': typeof getCategoryGroups;
  'category-group-create': typeof createCategoryGroup;
  'category-group-update': typeof updateCategoryGroup;
  'category-group-move': typeof moveCategoryGroup;
  'category-group-delete': typeof deleteCategoryGroup;
  'must-category-transfer': typeof isCategoryTransferRequired;
  'budget/get-category-automations': typeof goalActions.getTemplatesForCategory;
  'budget/set-category-automations': typeof goalActions.storeTemplates;
  'budget/dry-run-category-template': typeof goalActions.dryRunCategoryTemplate;
  'budget/store-note-templates': typeof goalNoteActions.storeNoteTemplates;
  'budget/store-note-cleanups': typeof storeNoteCleanups;
  'budget/render-note-templates': typeof goalNoteActions.unparse;
  'budget/create-cleanup-group': typeof cleanupGroupActions.createCleanupGroup;
};

export const app = createApp<BudgetHandlers>();

app.method('budget/budget-amount', mutator(undoable(actions.setBudget)));
app.method(
  'budget/copy-previous-month',
  mutator(undoable(actions.copyPreviousMonth)),
);
app.method(
  'budget/copy-single-month',
  mutator(undoable(actions.copySinglePreviousMonth)),
);
app.method('budget/set-zero', mutator(undoable(actions.setZero)));
app.method('budget/set-3month-avg', mutator(undoable(actions.set3MonthAvg)));
app.method('budget/set-6month-avg', mutator(undoable(actions.set6MonthAvg)));
app.method('budget/set-12month-avg', mutator(undoable(actions.set12MonthAvg)));
app.method('budget/set-n-month-avg', mutator(undoable(actions.setNMonthAvg)));
app.method(
  'budget/check-templates',
  mutator(undoable(goalActions.runCheckTemplates)),
);
app.method(
  'budget/apply-goal-template',
  mutator(undoable(goalActions.applyTemplate)),
);
app.method(
  'budget/apply-multiple-templates',
  mutator(undoable(goalActions.applyMultipleCategoryTemplates)),
);
app.method(
  'budget/overwrite-goal-template',
  mutator(undoable(goalActions.overwriteTemplate)),
);
app.method(
  'budget/apply-single-template',
  mutator(undoable(goalActions.applySingleCategoryTemplate)),
);
app.method(
  'budget/cleanup-goal-template',
  mutator(undoable(cleanupActions.cleanupTemplate)),
);
app.method(
  'budget/hold-for-next-month',
  mutator(undoable(actions.holdForNextMonth)),
);
app.method('budget/reset-hold', mutator(undoable(actions.resetHold)));
app.method(
  'budget/cover-overspending',
  mutator(undoable(actions.coverOverspending)),
);
app.method(
  'budget/transfer-available',
  mutator(undoable(actions.transferAvailable)),
);
app.method(
  'budget/cover-overbudgeted',
  mutator(undoable(actions.coverOverbudgeted)),
);
app.method(
  'budget/transfer-category',
  mutator(undoable(actions.transferCategory)),
);
app.method(
  'budget/copy-until-year-end',
  mutator(undoable(actions.copyUntilYearEnd)),
);
app.method(
  'budget/set-carryover',
  mutator(undoable(actions.setCategoryCarryover)),
);
app.method(
  'budget/reset-income-carryover',
  mutator(undoable(actions.resetIncomeCarryover)),
);
app.method('get-categories', getCategories);
app.method('get-budget-bounds', getBudgetBounds);
app.method('envelope-budget-month', envelopeBudgetMonth);
app.method('tracking-budget-month', trackingBudgetMonth);
app.method('category-create', mutator(undoable(createCategory)));
app.method('category-update', mutator(undoable(updateCategory)));
app.method('category-move', mutator(undoable(moveCategory)));
app.method('categories-sort', mutator(undoable(sortCategories)));
app.method('category-delete', mutator(undoable(deleteCategory)));
app.method('get-category-groups', getCategoryGroups);
app.method('category-group-create', mutator(undoable(createCategoryGroup)));
app.method('category-group-update', mutator(undoable(updateCategoryGroup)));
app.method('category-group-move', mutator(undoable(moveCategoryGroup)));
app.method('category-group-delete', mutator(undoable(deleteCategoryGroup)));
app.method('must-category-transfer', isCategoryTransferRequired);

app.method(
  'budget/get-category-automations',
  goalActions.getTemplatesForCategory,
);
app.method(
  'budget/set-category-automations',
  mutator(undoable(goalActions.storeTemplates)),
);
app.method(
  'budget/dry-run-category-template',
  goalActions.dryRunCategoryTemplate,
);
app.method(
  'budget/store-note-templates',
  mutator(goalNoteActions.storeNoteTemplates),
);
app.method('budget/store-note-cleanups', mutator(storeNoteCleanups));
app.method('budget/render-note-templates', goalNoteActions.unparse);
app.method(
  'budget/create-cleanup-group',
  mutator(undoable(cleanupGroupActions.createCleanupGroup)),
);

// Server must return AQL entities not the raw DB data
async function getCategories({
  budgetId,
  hidden,
}: {
  budgetId: string;
  hidden?: boolean;
}) {
  await validateBudgetExists(budgetId);
  const categoryGroups = await getCategoryGroups({ budgetId, hidden });
  let list: CategoryEntity[];
  if (hidden === true) {
    // A hidden category can live in a visible group, so when the caller
    // explicitly asks for hidden categories the flat list must look beyond
    // the (already hidden-filtered) groups returned above.
    const { data }: { data: CategoryEntity[] } = await aqlQuery(
      q('categories').filter({ budget_id: budgetId, hidden: true }).select('*'),
    );
    list = data;
  } else {
    list = categoryGroups.flatMap(g => g.categories ?? []);
  }
  return {
    grouped: categoryGroups,
    list,
  };
}

async function getBudgetBounds() {
  return await budget.createAllBudgets();
}

async function envelopeBudgetMonth({ month }: { month: string }) {
  const groups = await db.getCategoriesGrouped();
  const sheetName = monthUtils.sheetForMonth(month);

  function value(name: string) {
    const v = sheet.getCellValue(sheetName, name);
    return { value: v === '' ? 0 : v, name: resolveName(sheetName, name) };
  }

  let values = [
    value('available-funds'),
    value('last-month-overspent'),
    value('buffered'),
    value('total-budgeted'),
    value('to-budget'),

    value('from-last-month'),
    value('total-income'),
    value('total-spent'),
    value('total-leftover'),
  ];

  for (const group of groups) {
    const categories = group.categories ?? [];

    if (group.is_income) {
      values.push(value('total-income'));

      for (const cat of categories) {
        values.push(value(`sum-amount-${cat.id}`));
      }
    } else {
      values = values.concat([
        value(`group-budget-${group.id}`),
        value(`group-sum-amount-${group.id}`),
        value(`group-leftover-${group.id}`),
      ]);

      for (const cat of categories) {
        values = values.concat([
          value(`budget-${cat.id}`),
          value(`sum-amount-${cat.id}`),
          value(`leftover-${cat.id}`),
          value(`carryover-${cat.id}`),
          value(`goal-${cat.id}`),
          value(`long-goal-${cat.id}`),
        ]);
      }
    }
  }

  return values;
}

async function trackingBudgetMonth({ month }: { month: string }) {
  const groups = await db.getCategoriesGrouped();
  const sheetName = monthUtils.sheetForMonth(month);

  function value(name: string) {
    const v = sheet.getCellValue(sheetName, name);
    return { value: v === '' ? 0 : v, name: resolveName(sheetName, name) };
  }

  let values = [
    value('total-budgeted'),
    value('total-budget-income'),
    value('total-saved'),
    value('total-income'),
    value('total-spent'),
    value('real-saved'),
    value('total-leftover'),
  ];

  for (const group of groups) {
    values = values.concat([
      value(`group-budget-${group.id}`),
      value(`group-sum-amount-${group.id}`),
      value(`group-leftover-${group.id}`),
    ]);

    const categories = group.categories ?? [];

    for (const cat of categories) {
      values = values.concat([
        value(`budget-${cat.id}`),
        value(`sum-amount-${cat.id}`),
        value(`leftover-${cat.id}`),
        value(`goal-${cat.id}`),
        value(`long-goal-${cat.id}`),
      ]);

      if (!group.is_income) {
        values.push(value(`carryover-${cat.id}`));
      }
    }
  }

  return values;
}

async function createCategory({
  budgetId,
  name,
  groupId,
  isIncome,
  hidden,
}: {
  budgetId: string;
  name: string;
  groupId: CategoryGroupEntity['id'];
  isIncome?: boolean;
  hidden?: boolean;
}): Promise<CategoryEntity['id']> {
  if (!groupId) {
    throw APIError('Creating a category: groupId is required');
  }

  await assertBudgetOwner(budgetId, [
    { table: 'category_groups', id: groupId },
  ]);
  return await db.insertCategory({
    budget_id: budgetId,
    name: name.trim(),
    cat_group: groupId,
    is_income: isIncome ? 1 : 0,
    hidden: hidden ? 1 : 0,
  });
}

async function updateCategory(category: CategoryEntity): Promise<void> {
  const owner = await getBudgetIdForEntity({
    table: 'categories',
    id: category.id,
  });
  await assertBudgetOwner(owner, [
    { table: 'categories', id: category.id },
    { table: 'category_groups', id: category.group },
  ]);
  await assertCleanupGroupsOwner(owner, category.cleanup_def);
  try {
    await db.updateCategory(
      categoryModel.toDb({
        ...category,
        name: category.name.trim(),
      }),
    );
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.toLowerCase().includes('unique constraint')
    ) {
      throw new Error(
        `A category with the name "${category.name}" already exists.`,
        { cause: e },
      );
    }
    throw e;
  }
}

async function assertCleanupGroupsOwner(
  budgetId: string,
  cleanupDefinition: string | undefined,
): Promise<void> {
  if (!cleanupDefinition) return;
  const templates = JSON.parse(cleanupDefinition) as Array<{
    groupId?: string | null;
  }>;
  const groupIds = [
    ...new Set(
      templates
        .map(template => template.groupId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  if (groupIds.length > 0) {
    await assertBudgetOwner(
      budgetId,
      groupIds.map(id => ({ table: 'cleanup_groups' as const, id })),
    );
  }
}

async function moveCategory({
  id,
  groupId,
  targetId,
}: {
  id: CategoryEntity['id'];
  groupId: CategoryGroupEntity['id'];
  targetId: CategoryEntity['id'] | null;
}): Promise<void> {
  const owner = await getBudgetIdForEntity({ table: 'categories', id });
  const references = [
    { table: 'categories' as const, id },
    { table: 'category_groups' as const, id: groupId },
    ...(targetId ? [{ table: 'categories' as const, id: targetId }] : []),
  ];
  await assertBudgetOwner(owner, references);
  await batchMessages(async () => {
    await db.moveCategory(id, groupId, targetId);
  });
}

async function deleteCategory({
  id,
  transferId,
}: {
  id: CategoryEntity['id'];
  transferId?: CategoryEntity['id'] | null;
}): Promise<void> {
  const owner = await getBudgetIdForEntity({ table: 'categories', id });
  const references = [{ table: 'categories' as const, id }];
  if (transferId != null) {
    references.push({ table: 'categories', id: transferId });
  }
  await assertBudgetOwner(owner, references);
  const remapped = await db.all<{ id: string }>(
    'SELECT id FROM category_mapping WHERE transferId = ?',
    [id],
  );
  await assertBudgetOwner(
    owner,
    remapped.map(mapping => ({
      table: 'categories' as const,
      id: mapping.id,
    })),
  );
  await batchMessages(async () => {
    const row = await db.first<Pick<db.DbCategory, 'is_income'>>(
      'SELECT is_income FROM categories WHERE id = ?',
      [id],
    );
    if (!row) {
      throw new Error(`Category with id ${id} not found.`);
    }

    const transfer =
      transferId &&
      (await db.first<Pick<db.DbCategory, 'is_income'>>(
        'SELECT is_income FROM categories WHERE id = ?',
        [transferId],
      ));

    if (transferId && !transfer) {
      throw new Error(`Transfer category with id ${transferId} not found.`);
    } else if (
      transferId &&
      row &&
      transfer &&
      row.is_income !== transfer.is_income
    ) {
      throw new Error('Cannot transfer between income and expense categories.');
    }

    // Update spreadsheet values if it's an expense category
    // TODO: We should do this for income too if it's a tracking budget
    if (row.is_income === 0) {
      if (transferId) {
        await budget.doTransfer([id], transferId);
      }
    }

    await db.deleteCategory({ id }, transferId);
  });
}

// Server must return AQL entities not the raw DB data
async function getCategoryGroups({
  budgetId,
  hidden,
}: {
  budgetId: string;
  hidden?: boolean;
}) {
  await validateBudgetExists(budgetId);
  const baseQuery = q('category_groups')
    .filter({ budget_id: budgetId })
    .select('*');
  const query = hidden === undefined ? baseQuery : baseQuery.filter({ hidden });
  const { data: categoryGroups }: { data: CategoryGroupEntity[] } =
    await aqlQuery(query);
  return categoryGroups.map(group => ({
    ...group,
    categories: group.categories?.filter(
      category =>
        category.budget_id === budgetId &&
        (hidden === undefined || Boolean(category.hidden) === hidden),
    ),
  }));
}

async function createCategoryGroup({
  budgetId,
  name,
  isIncome,
  hidden,
}: {
  budgetId: string;
  name: CategoryGroupEntity['name'];
  isIncome?: CategoryGroupEntity['is_income'];
  hidden?: CategoryGroupEntity['hidden'];
}): Promise<CategoryGroupEntity['id']> {
  await validateBudgetExists(budgetId);
  return await db.insertCategoryGroup({
    budget_id: budgetId,
    name,
    is_income: isIncome ? 1 : 0,
    hidden: hidden ? 1 : 0,
  });
}

async function updateCategoryGroup(group: CategoryGroupEntity) {
  const budgetId = await getBudgetIdForEntity({
    table: 'category_groups',
    id: group.id,
  });
  if (group.budget_id !== undefined && group.budget_id !== budgetId) {
    throw new Error('Category group ownership cannot be changed');
  }
  await db.updateCategoryGroup(
    categoryGroupModel.toDb({ ...group, budget_id: budgetId }),
  );
}

async function moveCategoryGroup({
  id,
  targetId,
}: {
  id: CategoryGroupEntity['id'];
  targetId: CategoryGroupEntity['id'] | null;
}): Promise<void> {
  const owner = await getBudgetIdForEntity({ table: 'category_groups', id });
  const references = [{ table: 'category_groups' as const, id }];
  if (targetId != null) {
    references.push({ table: 'category_groups', id: targetId });
  }
  await assertBudgetOwner(owner, references);
  await batchMessages(async () => {
    await db.moveCategoryGroup(id, targetId);
  });
}

async function deleteCategoryGroup({
  id,
  transferId,
}: {
  id: CategoryGroupEntity['id'];
  transferId?: CategoryGroupEntity['id'] | null;
}): Promise<void> {
  const owner = await getBudgetIdForEntity({ table: 'category_groups', id });
  const groupCategories = await db.all<Pick<CategoryEntity, 'id'>>(
    'SELECT id FROM categories WHERE cat_group = ? AND budget_id = ? AND tombstone = 0',
    [id, owner],
  );
  if (transferId != null) {
    await assertBudgetOwner(owner, [
      { table: 'category_groups', id },
      { table: 'categories', id: transferId },
      ...groupCategories.map(category => ({
        table: 'categories' as const,
        id: category.id,
      })),
    ]);
  }

  await batchMessages(async () => {
    if (transferId) {
      await budget.doTransfer(
        groupCategories.map(c => c.id),
        transferId,
      );
    }
    await db.deleteCategoryGroup({ id }, transferId);
  });
}

async function isCategoryTransferRequired({
  id,
}: {
  id: CategoryEntity['id'];
}) {
  const res = db.runQuery<{ count: number }>(
    `SELECT count(t.id) as count FROM transactions t
       LEFT JOIN category_mapping cm ON cm.id = t.category
       WHERE cm.transferId = ? AND t.tombstone = 0`,
    [id],
    true,
  );

  // If there are transactions with this category, return early since
  // we already know it needs to be tranferred
  if (res[0].count !== 0) {
    return true;
  }

  // If there are any non-zero budget values, also force the user to
  // transfer the category.
  return [...(sheet.get().meta().createdMonths as Set<string>)].some(month => {
    const sheetName = monthUtils.sheetForMonth(month);
    const value = sheet.get().getCellValue(sheetName, 'budget-' + id);

    return value != null && value !== 0;
  });
}
