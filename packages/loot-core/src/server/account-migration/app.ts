import { v4 as uuidv4 } from 'uuid';

import * as connection from '#platform/server/connection';
import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { ValidationError } from '#server/errors';
import { getExchangeRates } from '#server/exchange-rates/app';
import { mutator } from '#server/mutators';
import * as prefs from '#server/prefs';
import { batchMessages } from '#server/sync';
import { undoable } from '#server/undo';
import { currencies } from '#shared/currencies';
import { DEFAULT_DASHBOARD_STATE } from '#shared/dashboard';
import { currentDay } from '#shared/months';
import { q } from '#shared/query';
import type { BudgetSpaceEntity, TransactionEntity } from '#types/models';

import { getMigrationBlockers } from './eligibility';
import {
  getRetainedTransactions,
  isReconciliationAdjustment,
  transformAccountTransactions,
} from './transform';
import type { MigrationTransaction } from './transform';
import { validateMigrationWriteSet } from './validate-write-set';

type Destination =
  | { type: 'existing'; budgetId: string }
  | { type: 'new'; name: string; currencyCode: string };

type PrepareArgs = {
  requestId: string;
  sourceAccountId: string;
  destination: Destination;
  inputCurrency: string;
  accountName: string;
  offBudget: boolean;
  targetBalance?: number;
  adjustmentNote?: string;
  categoryDecisions?: Record<string, string>;
};

type CategoryDecision = string;
type PreparedMove = {
  token: string;
  fileId: string;
  sourceAccount: db.DbAccount;
  sourceBudget: db.DbBudgetSpace;
  destinationBudget: BudgetSpaceEntity;
  newBudget: boolean;
  destinationAccountId: string;
  transferPayeeId: string;
  pendingDashboardId: string | null;
  newBudgetScaffold: {
    incomeGroupId: string;
    expenseGroupId: string;
    startingCategoryId: string;
  } | null;
  pendingRules: Array<{
    id: string;
    budget_id: string;
    stage: string | null;
    conditions: string;
    actions: string;
    conditions_op: string;
    tombstone: 0;
  }>;
  pendingCategories: Array<{
    id: string;
    groupId: string;
    name: string;
    groupName: string;
    isIncome: boolean;
    hidden: boolean;
    sourceId: string;
  }>;
  categoryMap: Record<string, string>;
  categoryDecisions: Record<string, CategoryDecision>;
  sourceRows: MigrationTransaction[];
  counterpartUpdates: Array<{ transaction: TransactionEntity; note: string }>;
  allSourceRows: TransactionEntity[];
  fingerprint: string;
  migrationDate: string;
  transformed: ReturnType<typeof transformAccountTransactions> | null;
  review: Record<string, unknown>;
  createdAt: number;
  accountName: string;
  offBudget: boolean;
  missingRates: string[];
};

const preparations = new Map<string, PreparedMove>();
const cancelledRequests = new Set<string>();
const receipts = new Map<
  string,
  { accountId: string; budgetId: string; expiresAt: number }
>();
const PREPARATION_TTL = 30 * 60 * 1000;
const MAX_TEMPORARY_OPERATIONS = 20;

export function clearAccountMigrationPreparations(): void {
  preparations.clear();
  receipts.clear();
  cancelledRequests.clear();
}

export type AccountMigrationHandlers = {
  'account-migration/check': typeof checkAccountMigration;
  'account-migration/prepare': typeof prepareAccountMigration;
  'account-migration/cancel': typeof cancelAccountMigration;
  'account-migration/commit': typeof commitAccountMigration;
};

export const app = createApp<AccountMigrationHandlers>();
app.method('account-migration/check', checkAccountMigration);
app.method('account-migration/prepare', prepareAccountMigration);
app.method('account-migration/cancel', cancelAccountMigration);
app.method(
  'account-migration/commit',
  mutator(undoable(commitAccountMigration)),
);

function cleanExpiredPreparations() {
  const cutoff = Date.now() - PREPARATION_TTL;
  for (const [token, prepared] of preparations) {
    if (prepared.createdAt < cutoff) preparations.delete(token);
  }
  for (const [token, receipt] of receipts) {
    if (receipt.expiresAt < Date.now()) receipts.delete(token);
  }
}

async function getAccount(id: string): Promise<db.DbAccount> {
  const account = await db.first<db.DbAccount>(
    'SELECT * FROM accounts WHERE id = ? AND tombstone = 0',
    [id],
  );
  if (!account) {
    throw new ValidationError('The source account no longer exists');
  }
  return account;
}

async function checkAccountMigration({
  sourceAccountId,
}: {
  sourceAccountId: string;
}) {
  const account = await getAccount(sourceAccountId);
  const budget = await db.first<db.DbBudgetSpace>(
    'SELECT * FROM budgets WHERE id = ? AND tombstone = 0',
    [account.budget_id],
  );
  if (!budget) {
    throw new ValidationError('The source budget space no longer exists');
  }
  const blockers = await getMigrationBlockers(account);
  return {
    account: {
      id: account.id,
      name: account.name,
      budgetId: account.budget_id,
      offBudget: account.offbudget === 1,
      closed: account.closed === 1,
    },
    sourceBudget: {
      id: budget.id,
      name: budget.name,
      currencyCode: budget.currency_code,
    },
    blockers,
    eligible: blockers.length === 0,
  };
}

function validateCurrency(code: string): void {
  if (!code || !currencies.some(currency => currency.code === code)) {
    throw new ValidationError(`Unknown currency code: ${code}`);
  }
}

async function getDestinationBudget(
  destination: Destination,
): Promise<{ budget: BudgetSpaceEntity; isNew: boolean }> {
  if (destination.type === 'existing') {
    const budget = await db.first<db.DbBudgetSpace>(
      'SELECT * FROM budgets WHERE id = ? AND tombstone = 0',
      [destination.budgetId],
    );
    if (!budget) {
      throw new ValidationError('The destination budget space is unavailable');
    }
    validateCurrency(budget.currency_code);
    return {
      budget: {
        id: budget.id,
        name: budget.name,
        currency_code: budget.currency_code,
        budget_type:
          budget.budget_type === 'tracking' ? 'tracking' : 'envelope',
        sort_order: budget.sort_order,
        tombstone: false,
      },
      isNew: false,
    };
  }

  validateCurrency(destination.currencyCode);
  if (typeof destination.name !== 'string' || !destination.name.trim()) {
    throw new ValidationError('New budget space name must not be empty');
  }
  const flag = await db.first<{ value: string }>(
    'SELECT value FROM preferences WHERE id = ?',
    ['flags.multiCurrency'],
  );
  if (flag?.value !== 'true') {
    throw new ValidationError('Creating additional budget spaces is disabled');
  }
  const existing = await db.all<Pick<db.DbBudgetSpace, 'id' | 'currency_code'>>(
    'SELECT id, currency_code FROM budgets WHERE tombstone = 0',
  );
  if (
    existing.some(
      row =>
        !row.currency_code ||
        !currencies.some(c => c.code === row.currency_code),
    )
  ) {
    throw new ValidationError(
      'All budget spaces must have a known currency before creating another',
    );
  }
  const last = await db.first<{ sort_order: number }>(
    'SELECT sort_order FROM budgets WHERE tombstone = 0 ORDER BY sort_order DESC LIMIT 1',
  );
  return {
    budget: {
      id: uuidv4(),
      name: destination.name.trim(),
      currency_code: destination.currencyCode,
      budget_type: 'envelope',
      sort_order: (last?.sort_order ?? 0) + 1000,
      tombstone: false,
    },
    isNew: true,
  };
}

async function getSourceRows(
  accountId: string,
): Promise<MigrationTransaction[]> {
  const { data } = await aqlQuery(
    q('transactions')
      .filter({ account: accountId })
      .select('*')
      .options({ splits: 'grouped' }),
  );
  return data as MigrationTransaction[];
}

async function getCategoryInfo(budgetId: string) {
  const categories = await db.all<db.DbCategory>(
    'SELECT * FROM categories WHERE budget_id = ? AND tombstone = 0 ORDER BY sort_order, id',
    [budgetId],
  );
  const groups = await db.all<db.DbCategoryGroup>(
    'SELECT * FROM category_groups WHERE budget_id = ? AND tombstone = 0',
    [budgetId],
  );
  const groupsById = new Map(groups.map(group => [group.id, group]));
  return { categories, groups, groupsById };
}

function getUsedCategoryIds(rows: MigrationTransaction[]): string[] {
  return [
    ...new Set(
      getRetainedTransactions(rows)
        .map(row => row.category)
        .filter((id): id is string => !!id),
    ),
  ];
}

async function getCounterparts(
  sourceRows: MigrationTransaction[],
  sourceAccount: db.DbAccount,
): Promise<PreparedMove['counterpartUpdates']> {
  const sourceTransactions = sourceRows.flatMap(row => [
    row,
    ...(row.subtransactions ?? []),
  ]);
  const counterpartIds = [
    ...new Set(
      sourceTransactions
        .map(row => row.transfer_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const sourceIds = sourceTransactions.map(transaction => transaction.id);
  if (sourceIds.length > 0) {
    const expectedCounterparts = new Set(counterpartIds);
    for (let offset = 0; offset < sourceIds.length; offset += 500) {
      const chunk = sourceIds.slice(offset, offset + 500);
      const inboundTransferLinks = await db.all<{ id: string }>(
        `SELECT id FROM v_transactions WHERE transfer_id IN (${chunk.map(() => '?').join(',')})`,
        chunk,
      );
      if (
        inboundTransferLinks.some(link => !expectedCounterparts.has(link.id))
      ) {
        throw new ValidationError(
          'A transaction outside the source account has a dangling transfer link to it',
        );
      }
    }
  }
  for (const transaction of sourceTransactions) {
    if (!transaction.payee) continue;
    const payee = await db.first<{ transfer_acct: string | null }>(
      'SELECT transfer_acct FROM payees WHERE id = ? AND tombstone = 0',
      [transaction.payee],
    );
    if (payee?.transfer_acct && !transaction.transfer_id) {
      throw new ValidationError(
        `Transaction ${transaction.id} has an inconsistent transfer payee reference`,
      );
    }
  }
  const updates: PreparedMove['counterpartUpdates'] = [];
  for (const id of counterpartIds) {
    const counterpart = await db.getTransaction(id);
    if (!counterpart || counterpart.transfer_id == null) {
      throw new ValidationError(
        `Transfer counterpart ${id} is missing or inconsistent`,
      );
    }
    const reverse = await db.getTransaction(counterpart.transfer_id);
    if (
      !reverse ||
      reverse.account !== sourceAccount.id ||
      reverse.transfer_id !== counterpart.id
    ) {
      throw new ValidationError(
        `Transfer link for transaction ${id} is not reciprocal`,
      );
    }
    if (reverse.payee) {
      const reversePayee = await db.first<{ transfer_acct: string | null }>(
        'SELECT transfer_acct FROM payees WHERE id = ? AND tombstone = 0',
        [reverse.payee],
      );
      if (
        reversePayee?.transfer_acct &&
        reversePayee.transfer_acct !== counterpart.account
      ) {
        throw new ValidationError(
          `Transfer payee for transaction ${reverse.id} points to an unrelated account`,
        );
      }
    }
    if (counterpart.payee) {
      const transferPayee = await db.first<{ transfer_acct: string | null }>(
        'SELECT transfer_acct FROM payees WHERE id = ? AND tombstone = 0',
        [counterpart.payee],
      );
      if (
        transferPayee?.transfer_acct &&
        transferPayee.transfer_acct !== sourceAccount.id
      ) {
        throw new ValidationError(
          `Transfer payee for transaction ${id} points to an unrelated account`,
        );
      }
    }
    const account = await db.first<db.DbAccount>(
      'SELECT * FROM accounts WHERE id = ? AND tombstone = 0',
      [counterpart.account],
    );
    if (!account || account.budget_id !== sourceAccount.budget_id) {
      throw new ValidationError(
        `Transfer counterpart ${id} is outside the source budget`,
      );
    }
    const note = `${counterpart.notes ? `${counterpart.notes}\n\n` : ''}Transfer between ${account.name} and ${sourceAccount.name} was detached because one account was moved to another budget space.`;
    updates.push({ transaction: counterpart, note });
  }
  return updates;
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

async function readDependencies(
  sourceAccount: db.DbAccount,
  sourceRows: MigrationTransaction[],
  destinationBudgetId: string,
) {
  const counterpartUpdates = await getCounterparts(sourceRows, sourceAccount);
  const sourceCats = await getCategoryInfo(sourceAccount.budget_id);
  const destinationCats = await getCategoryInfo(destinationBudgetId);
  const budgets = await db.all<db.DbBudgetSpace>(
    'SELECT * FROM budgets WHERE tombstone = 0 ORDER BY id',
  );
  const sourceRules = await db.all<db.DbRule>(
    'SELECT * FROM rules WHERE budget_id = ? AND tombstone = 0 ORDER BY id',
    [sourceAccount.budget_id],
  );
  const destinationRules = await db.all<db.DbRule>(
    'SELECT * FROM rules WHERE budget_id = ? AND tombstone = 0 ORDER BY id',
    [destinationBudgetId],
  );
  const schedules = await db.all<db.DbSchedule>(
    'SELECT * FROM schedules WHERE budget_id = ? AND tombstone = 0 ORDER BY id',
    [sourceAccount.budget_id],
  );
  const accounts = await db.all<db.DbAccount>(
    'SELECT * FROM accounts WHERE budget_id IN (?, ?) AND tombstone = 0 ORDER BY id',
    [sourceAccount.budget_id, destinationBudgetId],
  );
  const categoryMappings = await db.all<db.DbCategoryMapping>(
    'SELECT * FROM category_mapping ORDER BY id',
  );
  const payees = await db.all<db.DbPayee>('SELECT * FROM payees ORDER BY id');
  return {
    counterpartUpdates,
    fingerprint: fingerprint({
      sourceAccount,
      sourceRows,
      sourceCats,
      destinationCats,
      counterpartUpdates,
      budgets,
      sourceRules,
      destinationRules,
      schedules,
      accounts,
      categoryMappings,
      payees,
    }),
  };
}

async function prepareAccountMigration(args: PrepareArgs) {
  cleanExpiredPreparations();
  if (!args.requestId) {
    throw new ValidationError('A preparation request ID is required');
  }
  cancelledRequests.delete(args.requestId);
  connection.send('account-migration-progress', {
    operationId: args.requestId,
    phase: 'reading-transactions',
  });
  const { sourceAccountId, destination, inputCurrency } = args;
  const sourceAccount = await getAccount(sourceAccountId);
  const sourceBudget = await db.first<db.DbBudgetSpace>(
    'SELECT * FROM budgets WHERE id = ? AND tombstone = 0',
    [sourceAccount.budget_id],
  );
  if (!sourceBudget) {
    throw new ValidationError('Source budget space is unavailable');
  }
  const { blockers } = await checkAccountMigration({ sourceAccountId });
  if (blockers.length > 0) {
    throw new ValidationError(
      'Resolve account migration blockers before continuing',
    );
  }
  const { budget: destinationBudget, isNew } =
    await getDestinationBudget(destination);
  if (destinationBudget.id === sourceAccount.budget_id) {
    throw new ValidationError('Choose a different destination budget space');
  }
  validateCurrency(inputCurrency);
  if (typeof args.accountName !== 'string' || !args.accountName.trim()) {
    throw new ValidationError('Destination account name is required');
  }
  if (
    args.targetBalance !== undefined &&
    !Number.isSafeInteger(args.targetBalance)
  ) {
    throw new ValidationError(
      'Target balance must be a safe integer in destination minor units',
    );
  }

  const sourceRows = await getSourceRows(sourceAccountId);
  if (cancelledRequests.has(args.requestId)) {
    cancelledRequests.delete(args.requestId);
    throw new ValidationError('Account migration preparation was cancelled');
  }
  const allSourceRows = await db.getTransactions(sourceAccountId);
  const retainedRows = getRetainedTransactions(sourceRows);
  const usedCategoryIds = getUsedCategoryIds(sourceRows);
  const sourceCategoryInfo = await getCategoryInfo(sourceAccount.budget_id);
  const newBudgetScaffold = isNew
    ? {
        incomeGroupId: uuidv4(),
        expenseGroupId: uuidv4(),
        startingCategoryId: uuidv4(),
      }
    : null;
  const destinationCategoryInfo = isNew
    ? {
        categories: [
          {
            id: newBudgetScaffold!.startingCategoryId,
            budget_id: destinationBudget.id,
            name: 'Starting Balances',
            is_income: 1,
            cat_group: newBudgetScaffold!.incomeGroupId,
            sort_order: 0,
            hidden: 0,
            tombstone: 0,
          },
        ] as db.DbCategory[],
        groups: [
          {
            id: newBudgetScaffold!.incomeGroupId,
            budget_id: destinationBudget.id,
            name: 'Income',
            is_income: 1,
            sort_order: 0,
            hidden: 0,
            tombstone: 0,
          },
          {
            id: newBudgetScaffold!.expenseGroupId,
            budget_id: destinationBudget.id,
            name: 'Expenses',
            is_income: 0,
            sort_order: 0,
            hidden: 0,
            tombstone: 0,
          },
        ] as db.DbCategoryGroup[],
        groupsById: new Map<string, db.DbCategoryGroup>(),
      }
    : await getCategoryInfo(destinationBudget.id);
  const destinationGroupsById = new Map(
    destinationCategoryInfo.groups.map(group => [group.id, group]),
  );
  const decisions = args.categoryDecisions ?? {};
  const categoryMap: Record<string, string> = {};
  const pendingCategories: PreparedMove['pendingCategories'] = [];
  const destinationPayeeIds = new Set(
    getRetainedTransactions(sourceRows)
      .map(transaction => transaction.payee)
      .filter((id): id is string => !!id),
  );
  const sourceRules = await db.all<db.DbRule>(
    'SELECT * FROM rules WHERE budget_id = ? AND tombstone = 0 ORDER BY id',
    [sourceAccount.budget_id],
  );
  const destinationRules = isNew
    ? []
    : await db.all<db.DbRule>(
        'SELECT * FROM rules WHERE budget_id = ? AND tombstone = 0',
        [destinationBudget.id],
      );
  const pendingRules: PreparedMove['pendingRules'] = [];
  const pendingGroups = new Map<string, string>();
  const unresolvedCategories: Array<{
    id: string;
    name: string;
    sourceGroup: string;
    options: Array<{ id: string; groupName: string }>;
    createGroupOptions: Array<{ id: string; name: string }>;
    canCreate: boolean;
  }> = [];

  for (const sourceId of usedCategoryIds) {
    if (sourceAccount.offbudget === 1 || args.offBudget) continue;
    const sourceCategory = sourceCategoryInfo.categories.find(
      category => category.id === sourceId,
    );
    if (!sourceCategory) {
      throw new ValidationError(`Source category ${sourceId} no longer exists`);
    }
    const sourceGroup = sourceCategoryInfo.groupsById.get(
      sourceCategory.cat_group,
    );
    if (!sourceGroup) {
      throw new ValidationError(
        `Source category group for ${sourceId} no longer exists`,
      );
    }
    const compatible = destinationCategoryInfo.categories.filter(
      category =>
        category.name === sourceCategory.name &&
        category.is_income === sourceCategory.is_income,
    );
    const sameNamedGroupMatches = compatible.filter(
      category =>
        destinationGroupsById.get(category.cat_group)?.name ===
        sourceGroup.name,
    );
    const automaticMatches =
      sameNamedGroupMatches.length > 0 ? sameNamedGroupMatches : compatible;
    let chosenId: string | undefined;
    const decision = decisions[sourceId];
    if (decision && !decision.startsWith('create')) {
      if (!automaticMatches.some(category => category.id === decision)) {
        throw new ValidationError(
          `Invalid destination category choice for ${sourceCategory.name}`,
        );
      }
      chosenId = decision;
    } else if (decision?.startsWith('create')) {
      chosenId = uuidv4();
      const matchingGroups = destinationCategoryInfo.groups.filter(
        candidate =>
          candidate.name === sourceGroup.name &&
          candidate.is_income === sourceGroup.is_income,
      );
      const selectedGroupId = decision.startsWith('create:')
        ? decision.slice('create:'.length)
        : null;
      if (matchingGroups.length > 1 && !selectedGroupId) {
        unresolvedCategories.push({
          id: sourceId,
          name: sourceCategory.name,
          sourceGroup: sourceGroup.name,
          options: [],
          createGroupOptions: matchingGroups.map(group => ({
            id: group.id,
            name: group.name,
          })),
          canCreate: true,
        });
        continue;
      }
      if (
        selectedGroupId &&
        selectedGroupId !== 'new' &&
        !matchingGroups.some(group => group.id === selectedGroupId)
      ) {
        throw new ValidationError(
          `Invalid destination group choice for ${sourceCategory.name}`,
        );
      }
      const group = matchingGroups.find(group => group.id === selectedGroupId);
      let groupId: string;
      if (group) {
        groupId = group.id;
      } else {
        groupId =
          pendingGroups.get(
            `${sourceGroup.name}\u0000${sourceGroup.is_income}`,
          ) ?? uuidv4();
        pendingGroups.set(
          `${sourceGroup.name}\u0000${sourceGroup.is_income}`,
          groupId,
        );
      }
      const matchingPendingCategory = pendingCategories.find(
        category =>
          category.groupId === groupId &&
          category.name === sourceCategory.name &&
          category.isIncome === !!sourceCategory.is_income,
      );
      if (matchingPendingCategory) {
        chosenId = matchingPendingCategory.id;
      } else {
        pendingCategories.push({
          id: chosenId,
          groupId,
          name: sourceCategory.name,
          groupName: sourceGroup.name,
          isIncome: !!sourceCategory.is_income,
          hidden: !!sourceCategory.hidden,
          sourceId,
        });
      }
    } else if (automaticMatches.length === 1) {
      chosenId = automaticMatches[0].id;
    } else if (automaticMatches.length === 0) {
      unresolvedCategories.push({
        id: sourceId,
        name: sourceCategory.name,
        sourceGroup: sourceGroup.name,
        options: [],
        createGroupOptions: destinationCategoryInfo.groups
          .filter(
            group =>
              group.name === sourceGroup.name &&
              group.is_income === sourceGroup.is_income,
          )
          .map(group => ({ id: group.id, name: group.name })),
        canCreate: true,
      });
    } else {
      unresolvedCategories.push({
        id: sourceId,
        name: sourceCategory.name,
        sourceGroup: sourceGroup.name,
        options: automaticMatches.map(category => ({
          id: category.id,
          groupName: destinationGroupsById.get(category.cat_group)?.name ?? '',
        })),
        createGroupOptions: [],
        canCreate: false,
      });
    }
    if (chosenId) categoryMap[sourceId] = chosenId;
  }

  let skippedApplicableRuleCount = 0;
  for (const rule of sourceRules) {
    const actions = JSON.parse(rule.actions) as Array<Record<string, unknown>>;
    const applicablePayees: string[] = [];
    for (const action of actions) {
      if (
        action.field !== 'payee' ||
        typeof action.value !== 'string' ||
        !destinationPayeeIds.has(action.value)
      ) {
        continue;
      }
      const payee = await db.first<{ transfer_acct: string | null }>(
        'SELECT transfer_acct FROM payees WHERE id = ? AND tombstone = 0',
        [action.value],
      );
      if (!payee?.transfer_acct) applicablePayees.push(action.value);
    }
    if (applicablePayees.length === 0) continue;

    const conditions = JSON.parse(rule.conditions) as Array<
      Record<string, unknown>
    >;
    let canCopyRule = true;
    const mappedConditions = conditions.map(condition => {
      if (condition.field === 'account') {
        if (
          ['is', 'isNot', 'oneOf', 'notOneOf'].includes(String(condition.op))
        ) {
          canCopyRule = false;
        }
        return condition;
      }
      if (
        condition.field !== 'category' &&
        condition.field !== 'category_group'
      ) {
        return condition;
      }
      const isGroup = condition.field === 'category_group';
      const values = Array.isArray(condition.value)
        ? condition.value
        : [condition.value];
      const mappedValues = values.map(value => {
        if (typeof value !== 'string') return null;
        if (!isGroup) return categoryMap[value] ?? null;
        const sourceGroup = sourceCategoryInfo.groupsById.get(value);
        if (!sourceGroup) return null;
        const pendingGroup = pendingCategories.find(category =>
          sourceCategoryInfo.categories.some(
            sourceCategory =>
              sourceCategory.id === category.sourceId &&
              sourceCategory.cat_group === value,
          ),
        );
        if (pendingGroup) return pendingGroup.groupId;
        const matches = destinationCategoryInfo.groups.filter(
          group =>
            group.name === sourceGroup.name &&
            group.is_income === sourceGroup.is_income,
        );
        return matches.length === 1 ? matches[0].id : null;
      });
      if (mappedValues.some(value => value == null)) {
        canCopyRule = false;
        return condition;
      }
      return {
        ...condition,
        value: Array.isArray(condition.value) ? mappedValues : mappedValues[0],
      };
    });
    const mappedActions: Array<Record<string, unknown>> = [];
    for (const action of actions) {
      if (action.op === 'link-schedule' || action.field === 'account') {
        canCopyRule = false;
        mappedActions.push(action);
        continue;
      }
      if (action.field === 'category') {
        const mapped =
          typeof action.value === 'string'
            ? categoryMap[action.value]
            : undefined;
        if (!mapped) canCopyRule = false;
        mappedActions.push(mapped ? { ...action, value: mapped } : action);
        continue;
      }
      if (action.field === 'payee' && typeof action.value === 'string') {
        const payee = await db.first<{ transfer_acct: string | null }>(
          'SELECT transfer_acct FROM payees WHERE id = ? AND tombstone = 0',
          [action.value],
        );
        if (payee?.transfer_acct) canCopyRule = false;
      }
      mappedActions.push(action);
    }
    if (!canCopyRule) {
      skippedApplicableRuleCount++;
      continue;
    }

    const serializedConditions = JSON.stringify(mappedConditions);
    const serializedActions = JSON.stringify(mappedActions);
    const exists = destinationRules.some(
      candidate =>
        candidate.stage === rule.stage &&
        candidate.conditions === serializedConditions &&
        candidate.actions === serializedActions &&
        candidate.conditions_op === rule.conditions_op,
    );
    if (exists) continue;
    pendingRules.push({
      id: uuidv4(),
      budget_id: destinationBudget.id,
      stage: rule.stage,
      conditions: serializedConditions,
      actions: serializedActions,
      conditions_op: rule.conditions_op,
      tombstone: 0,
    });
  }

  connection.send('account-migration-progress', {
    operationId: args.requestId,
    phase: 'preparing-preview',
  });
  const migrationDate = currentDay();
  const dates = [...new Set(retainedRows.map(row => row.date))].sort();
  const rates: Record<string, number> = {};
  let rateStatus: { isComplete: boolean; offline: boolean } = {
    isComplete: true,
    offline: false,
  };
  if (inputCurrency !== destinationBudget.currency_code && dates.length > 0) {
    connection.send('account-migration-progress', {
      operationId: args.requestId,
      phase: 'fetching-rates',
      completed: 0,
      total: dates.length,
    });
    const result = await getExchangeRates({
      from: inputCurrency,
      to: destinationBudget.currency_code,
      dates,
    });
    rateStatus = { isComplete: result.isComplete, offline: result.offline };
    for (const [date, rate] of Object.entries(result.rates)) {
      if (rate != null) rates[date] = rate;
    }
  }
  const missingRates = dates.filter(
    date =>
      rates[date] == null && inputCurrency !== destinationBudget.currency_code,
  );
  const destinationAccountId = uuidv4();
  const transferPayeeId = uuidv4();
  const idMap = new Map<string, string>();
  const idForSource = (id: string) => {
    let mapped = idMap.get(id);
    if (!mapped) {
      mapped = uuidv4();
      idMap.set(id, mapped);
    }
    return mapped;
  };
  let transformed: PreparedMove['transformed'] = null;
  if (missingRates.length === 0) {
    const result = transformAccountTransactions(sourceRows, {
      sourceAccountId,
      destinationAccountId,
      inputCurrency,
      destinationCurrency: destinationBudget.currency_code,
      rates,
      idForSource,
      adjustmentId: uuidv4(),
      migrationDate,
      targetBalance: args.targetBalance,
      adjustmentNote: args.adjustmentNote,
    });
    transformed = {
      ...result,
      transactions: result.transactions.map(transaction => {
        const { category, ...fields } = transaction;
        const mappedCategory = category ? categoryMap[category] : undefined;
        return {
          ...fields,
          ...(mappedCategory && !args.offBudget
            ? { category: mappedCategory }
            : {}),
        };
      }),
    };
  }
  const excluded = sourceRows.flatMap(row => {
    if (isReconciliationAdjustment(row)) {
      return [row, ...(row.subtransactions ?? [])].map(transaction => ({
        id: transaction.id,
        reason: 'reconciliation-adjustment' as const,
      }));
    }
    return (row.subtransactions ?? [])
      .filter(isReconciliationAdjustment)
      .map(transaction => ({
        id: transaction.id,
        reason: 'reconciliation-adjustment' as const,
      }));
  });
  const partialSplitExclusions = sourceRows.flatMap(row => {
    if (isReconciliationAdjustment(row)) return [];
    const excludedChildIds = (row.subtransactions ?? [])
      .filter(isReconciliationAdjustment)
      .map(transaction => transaction.id);
    return excludedChildIds.length > 0
      ? [{ id: row.id, excludedChildIds }]
      : [];
  });
  const unresolved = unresolvedCategories.length > 0 || missingRates.length > 0;
  if (cancelledRequests.has(args.requestId)) {
    cancelledRequests.delete(args.requestId);
    throw new ValidationError('Account migration preparation was cancelled');
  }
  const dependency = await readDependencies(
    sourceAccount,
    sourceRows,
    destinationBudget.id,
  );
  const token = uuidv4();
  const sourceDateValues = sourceRows.map(row => row.date).sort();
  const review = {
    sourceAccount: { id: sourceAccount.id, name: sourceAccount.name },
    sourceBudget: {
      id: sourceBudget.id,
      name: sourceBudget.name,
      currencyCode: sourceBudget.currency_code,
    },
    destinationBudget: {
      id: destinationBudget.id,
      name: destinationBudget.name,
      currencyCode: destinationBudget.currency_code,
    },
    destinationAccountId,
    inputCurrency,
    transactionCount:
      transformed?.transactions.filter(transaction => !transaction.is_child)
        .length ??
      retainedRows.filter(transaction => !transaction.is_child).length,
    sourceTransactionCount: allSourceRows.length,
    excluded: transformed?.excluded ?? excluded,
    partialSplitExclusions:
      transformed?.partialSplitExclusions ?? partialSplitExclusions,
    counterpartCount: dependency.counterpartUpdates.length,
    dateRange: sourceDateValues.length
      ? [sourceDateValues[0], sourceDateValues[sourceDateValues.length - 1]]
      : null,
    convertedTotal: transformed?.convertedTotal ?? null,
    adjustment: transformed?.adjustment ?? null,
    finalBalance: transformed?.finalBalance ?? null,
    representativeTransactions: transformed?.representativeTransactions ?? [],
    missingRates,
    offline: rateStatus.offline,
    unresolvedCategories,
    copiedRuleCount: pendingRules.length,
    skippedApplicableRuleCount,
    categoryCreations: pendingCategories.map(
      ({ id, groupId, name, groupName }) => ({ id, groupId, name, groupName }),
    ),
    canCommit: !unresolved,
    newBudget: isNew,
  };
  const prepared: PreparedMove = {
    token,
    fileId: prefs.getPrefs()?.id ?? '',
    sourceAccount,
    sourceBudget,
    destinationBudget,
    newBudget: isNew,
    destinationAccountId,
    transferPayeeId,
    pendingDashboardId: isNew ? uuidv4() : null,
    newBudgetScaffold,
    pendingCategories,
    pendingRules,
    categoryMap,
    categoryDecisions: decisions,
    sourceRows,
    counterpartUpdates: dependency.counterpartUpdates,
    allSourceRows,
    fingerprint: dependency.fingerprint,
    migrationDate,
    transformed,
    review,
    createdAt: Date.now(),
    accountName: args.accountName.trim(),
    offBudget: args.offBudget,
    missingRates,
  };
  while (preparations.size >= MAX_TEMPORARY_OPERATIONS) {
    const oldestToken = preparations.keys().next().value;
    if (!oldestToken) break;
    preparations.delete(oldestToken);
  }
  preparations.set(token, prepared);
  connection.send('account-migration-progress', {
    operationId: args.requestId,
    phase: 'review-ready',
    completed: dates.length,
    total: dates.length,
  });
  return { token, review };
}

async function cancelAccountMigration({
  token,
  requestId,
}: {
  token?: string;
  requestId?: string;
}) {
  if (token) preparations.delete(token);
  if (requestId) cancelledRequests.add(requestId);
  return { cancelled: true };
}

async function commitAccountMigration({ token }: { token: string }) {
  cleanExpiredPreparations();
  const prepared = preparations.get(token);
  if (!prepared) {
    const receipt = receipts.get(token);
    if (receipt) {
      const destination = await db.first<{ id: string }>(
        'SELECT id FROM accounts WHERE id = ? AND tombstone = 0',
        [receipt.accountId],
      );
      if (destination) {
        return {
          accountId: receipt.accountId,
          budgetId: receipt.budgetId,
          alreadyCommitted: true,
        };
      }
      receipts.delete(token);
    }
    throw new ValidationError(
      'This account migration preview expired. Prepare it again.',
    );
  }
  if (
    prepared.missingRates.length > 0 ||
    !prepared.review.canCommit ||
    !prepared.transformed
  ) {
    throw new ValidationError(
      'Resolve missing rates and category choices before committing',
    );
  }
  if ((prefs.getPrefs()?.id ?? '') !== prepared.fileId) {
    throw new ValidationError(
      'The loaded file changed. Prepare the migration again.',
    );
  }
  const sourceAccount = await getAccount(prepared.sourceAccount.id);
  const blockers = await getMigrationBlockers(sourceAccount);
  if (blockers.length > 0) {
    throw new ValidationError(
      'Account migration eligibility changed. Resolve blockers and prepare again.',
    );
  }
  const sourceRows = await getSourceRows(sourceAccount.id);
  const dependency = await readDependencies(
    sourceAccount,
    sourceRows,
    prepared.destinationBudget.id,
  );
  if (dependency.fingerprint !== prepared.fingerprint) {
    throw new ValidationError(
      'Account data changed after review. Prepare the migration again.',
    );
  }
  if (currentDay() !== prepared.migrationDate) {
    throw new ValidationError(
      'The migration date changed. Refresh the preview before committing.',
    );
  }
  if (prepared.newBudget) {
    const flag = await db.first<{ value: string }>(
      'SELECT value FROM preferences WHERE id = ?',
      ['flags.multiCurrency'],
    );
    const existingBudgets = await db.all<
      Pick<db.DbBudgetSpace, 'currency_code'>
    >('SELECT currency_code FROM budgets WHERE tombstone = 0');
    if (flag?.value !== 'true') {
      throw new ValidationError(
        'Creating additional budget spaces is disabled',
      );
    }
    if (
      existingBudgets.some(
        budget =>
          !budget.currency_code ||
          !currencies.some(currency => currency.code === budget.currency_code),
      )
    ) {
      throw new ValidationError(
        'A budget space currency changed after review. Prepare the migration again.',
      );
    }
  }

  if (prepared.newBudget && !prepared.newBudgetScaffold) {
    throw new ValidationError('The proposed budget scaffold is incomplete');
  }
  if (prepared.newBudget) {
    const budgetCollision = await db.first<{ id: string }>(
      'SELECT id FROM budgets WHERE id = ? AND tombstone = 0',
      [prepared.destinationBudget.id],
    );
    if (budgetCollision) {
      throw new ValidationError('The proposed budget ID is already in use');
    }
  }
  const existingDestinationCategories = prepared.newBudget
    ? []
    : await db.all<db.DbCategory>(
        'SELECT * FROM categories WHERE budget_id = ? AND tombstone = 0',
        [prepared.destinationBudget.id],
      );
  const existingDestinationGroups = prepared.newBudget
    ? []
    : await db.all<db.DbCategoryGroup>(
        'SELECT * FROM category_groups WHERE budget_id = ? AND tombstone = 0',
        [prepared.destinationBudget.id],
      );
  const proposedCategoryRows: db.DbCategory[] = prepared.pendingCategories.map(
    category => ({
      id: category.id,
      budget_id: prepared.destinationBudget.id,
      name: category.name,
      is_income: category.isIncome ? 1 : 0,
      cat_group: category.groupId,
      sort_order: 1000,
      hidden: category.hidden ? 1 : 0,
      tombstone: 0,
    }),
  );
  const proposedGroups = new Map<
    string,
    PreparedMove['pendingCategories'][number]
  >();
  for (const category of prepared.pendingCategories) {
    proposedGroups.set(category.groupId, category);
  }
  const proposedGroupRows: db.DbCategoryGroup[] = [...proposedGroups]
    .filter(
      ([id]) =>
        !existingDestinationGroups.some(group => group.id === id) &&
        ![
          prepared.newBudgetScaffold?.incomeGroupId,
          prepared.newBudgetScaffold?.expenseGroupId,
        ].includes(id),
    )
    .map(([id, category]) => ({
      id,
      budget_id: prepared.destinationBudget.id,
      name: category.groupName,
      is_income: category.isIncome ? 1 : 0,
      sort_order: 1000,
      hidden: 0,
      tombstone: 0,
    }));
  const scaffoldCategories: db.DbCategory[] = prepared.newBudgetScaffold
    ? [
        {
          id: prepared.newBudgetScaffold.startingCategoryId,
          budget_id: prepared.destinationBudget.id,
          name: 'Starting Balances',
          is_income: 1,
          cat_group: prepared.newBudgetScaffold.incomeGroupId,
          sort_order: 0,
          hidden: 0,
          tombstone: 0,
        },
      ]
    : [];
  const scaffoldGroups: db.DbCategoryGroup[] = prepared.newBudgetScaffold
    ? [
        {
          id: prepared.newBudgetScaffold.incomeGroupId,
          budget_id: prepared.destinationBudget.id,
          name: 'Income',
          is_income: 1,
          sort_order: 0,
          hidden: 0,
          tombstone: 0,
        },
        {
          id: prepared.newBudgetScaffold.expenseGroupId,
          budget_id: prepared.destinationBudget.id,
          name: 'Expenses',
          is_income: 0,
          sort_order: 0,
          hidden: 0,
          tombstone: 0,
        },
      ]
    : [];
  await validateMigrationWriteSet({
    sourceAccount,
    destinationAccountId: prepared.destinationAccountId,
    destinationBudgetId: prepared.destinationBudget.id,
    destinationCategories: [
      ...existingDestinationCategories,
      ...scaffoldCategories,
      ...proposedCategoryRows,
    ],
    destinationGroups: [
      ...existingDestinationGroups,
      ...scaffoldGroups,
      ...proposedGroupRows,
    ],
    categoryIds: [],
    groupIds: [],
    transactions: prepared.transformed.transactions,
    sourceRows: prepared.allSourceRows,
    rules: prepared.pendingRules,
  });
  connection.send('account-migration-progress', {
    operationId: token,
    phase: 'moving-transactions',
  });

  const destinationBudget = prepared.destinationBudget;
  if (prepared.newBudget && !prepared.newBudgetScaffold) {
    throw new ValidationError('The proposed budget scaffold is incomplete');
  }
  const newGroupRows = new Map<string, string>();
  for (const category of prepared.pendingCategories) {
    newGroupRows.set(category.groupId, category.groupName);
  }
  const existingGroups = prepared.newBudget
    ? []
    : await db.all<db.DbCategoryGroup>(
        'SELECT * FROM category_groups WHERE budget_id = ? AND tombstone = 0',
        [destinationBudget.id],
      );
  const scaffoldGroupIds = new Set(
    prepared.newBudgetScaffold
      ? [
          prepared.newBudgetScaffold.incomeGroupId,
          prepared.newBudgetScaffold.expenseGroupId,
        ]
      : [],
  );
  const groupRows = [...newGroupRows].filter(
    ([id]) =>
      !scaffoldGroupIds.has(id) &&
      !existingGroups.some(group => group.id === id),
  );

  try {
    await batchMessages(async () => {
      if (prepared.newBudget) {
        await db.insertWithSchema('budgets', destinationBudget);
        const scaffold = prepared.newBudgetScaffold!;
        const incomeGroupId = scaffold.incomeGroupId;
        const expenseGroupId = scaffold.expenseGroupId;
        const startingCategoryId = scaffold.startingCategoryId;
        await db.insertWithSchema('category_groups', {
          id: incomeGroupId,
          budget_id: destinationBudget.id,
          name: 'Income',
          is_income: true,
          sort_order: 0,
        });
        await db.insertWithSchema('categories', {
          id: startingCategoryId,
          budget_id: destinationBudget.id,
          name: 'Starting Balances',
          group: incomeGroupId,
          is_income: true,
          hidden: false,
          sort_order: 0,
        });
        await db.insert('category_mapping', {
          id: startingCategoryId,
          transferId: startingCategoryId,
        });
        await db.insertWithSchema('category_groups', {
          id: expenseGroupId,
          budget_id: destinationBudget.id,
          name: 'Expenses',
          is_income: false,
          sort_order: 0,
        });
        const pageId = prepared.pendingDashboardId;
        await db.insertWithSchema('dashboard_pages', {
          id: pageId,
          budget_id: destinationBudget.id,
          name: 'Main',
        });
        for (const widget of DEFAULT_DASHBOARD_STATE) {
          await db.insertWithSchema('dashboard', {
            ...widget,
            dashboard_page_id: pageId,
          });
        }
      }
      for (const [id, name] of groupRows) {
        const category = prepared.pendingCategories.find(
          row => row.groupId === id,
        )!;
        await db.insertWithSchema('category_groups', {
          id,
          budget_id: destinationBudget.id,
          name,
          is_income: category.isIncome,
          sort_order: 1000,
        });
      }
      for (const rule of prepared.pendingRules) {
        await db.insert('rules', rule);
      }
      for (const category of prepared.pendingCategories) {
        await db.insertWithSchema('categories', {
          id: category.id,
          budget_id: destinationBudget.id,
          name: category.name,
          group: category.groupId,
          is_income: category.isIncome,
          hidden: category.hidden,
          sort_order: 1000,
        });
        await db.insert('category_mapping', {
          id: category.id,
          transferId: category.id,
        });
      }

      const lastAccount = await db.first<{ sort_order: number }>(
        'SELECT sort_order FROM accounts WHERE budget_id = ? ORDER BY sort_order DESC LIMIT 1',
        [destinationBudget.id],
      );
      await db.insertWithSchema('accounts', {
        id: prepared.destinationAccountId,
        budget_id: destinationBudget.id,
        name: prepared.accountName,
        offbudget: prepared.offBudget ? 1 : 0,
        closed: 0,
        tombstone: 0,
        sort_order: (lastAccount?.sort_order ?? 0) + 1000,
        account_id: null,
        official_name: null,
        account_sync_source: null,
        last_reconciled: null,
        last_sync: null,
        bank_sync_status: null,
        account_group_id: null,
      });
      await db.insertWithSchema('payees', {
        id: prepared.transferPayeeId,
        name: '',
        transfer_acct: prepared.destinationAccountId,
        favorite: false,
        learn_categories: false,
        tombstone: false,
      });

      for (const update of prepared.counterpartUpdates) {
        await db.update('transactions', {
          id: update.transaction.id,
          transferred_id: null,
          description: null,
          notes: update.note,
        });
      }
      for (const transaction of prepared.transformed!.transactions) {
        await db.insertTransaction(transaction);
      }
      for (const row of prepared.allSourceRows) {
        await db.deleteTransaction({ id: row.id });
      }
      await db.update('accounts', { id: sourceAccount.id, closed: 1 });
    });
  } catch (error) {
    const [createdAccount, remainingTransactions] = await Promise.all([
      db.first<{ id: string }>(
        'SELECT id FROM accounts WHERE id = ? AND tombstone = 0',
        [prepared.destinationAccountId],
      ),
      db.first<{ count: number }>(
        'SELECT COUNT(*) AS count FROM transactions WHERE acct = ? AND tombstone = 0',
        [sourceAccount.id],
      ),
    ]);
    if (createdAccount && (remainingTransactions?.count ?? 0) === 0) {
      preparations.delete(token);
      const committedReceipt = {
        accountId: prepared.destinationAccountId,
        budgetId: destinationBudget.id,
      };
      receipts.set(token, {
        ...committedReceipt,
        expiresAt: Date.now() + PREPARATION_TTL,
      });
      return committedReceipt;
    }
    throw error;
  }

  preparations.delete(token);
  const receipt = {
    accountId: prepared.destinationAccountId,
    budgetId: destinationBudget.id,
  };
  while (receipts.size >= MAX_TEMPORARY_OPERATIONS) {
    const oldestToken = receipts.keys().next().value;
    if (!oldestToken) break;
    receipts.delete(oldestToken);
  }
  receipts.set(token, {
    ...receipt,
    expiresAt: Date.now() + PREPARATION_TTL,
  });
  connection.send('account-migration-progress', {
    operationId: token,
    phase: 'complete',
  });
  return receipt;
}
