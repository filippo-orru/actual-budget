// @ts-strict-ignore
import { getClock } from '@actual-app/crdt';

import * as connection from '#platform/server/connection';
import { logger } from '#platform/server/log';
import {
  getBankSyncError,
  getDownloadError,
  getSyncError,
  getTestKeyError,
} from '#shared/errors';
import * as monthUtils from '#shared/months';
import { q } from '#shared/query';
import {
  deleteTransaction,
  ungroupTransactions,
  updateTransaction,
} from '#shared/transactions';
import { integerToAmount } from '#shared/util';
import type { Handlers } from '#types/handlers';
import type {
  AccountEntity,
  CategoryGroupEntity,
  ScheduleEntity,
} from '#types/models';
import type { ServerHandlers } from '#types/server-handlers';

import { addTransactions } from './accounts/sync';
import {
  accountGroupModel,
  accountModel,
  budgetModel,
  categoryGroupModel,
  categoryModel,
  payeeModel,
  remoteFileModel,
  ruleModel,
  scheduleModel,
  tagModel,
} from './api-models';
import type { AmountOPType, APIScheduleEntity } from './api-models';
import { aqlQuery } from './aql';
import {
  assertBudgetOwner,
  getBudgetDecimalPlaces,
  getBudgetIdForEntity,
  resolveBudgetId,
} from './budget-spaces/helpers';
import { isTrackingBudget } from './budget/actions';
import * as cloudStorage from './cloud-storage';
import type { RemoteFile } from './cloud-storage';
import * as db from './db';
import { APIError, withErrorCode } from './errors';
import { runMutator } from './mutators';
import * as prefs from './prefs';
import * as sheet from './sheet';
import { batchMessages, setSyncingMode } from './sync';

let IMPORT_MODE = false;

// The API is different in two ways: we never want undo enabled, and
// we also need to notify the UI manually if stuff has changed (if
// they are connecting to an already running instance, the UI should
// update). The wrapper handles that.
function withMutation<Params extends Array<unknown>, ReturnType>(
  handler: (...args: Params) => Promise<ReturnType>,
) {
  return (...args: Params) => {
    return runMutator(
      async () => {
        const latestTimestamp = getClock().timestamp.toString();
        const result = await handler(...args);

        const rows = await db.all<Pick<db.DbCrdtMessage, 'dataset'>>(
          'SELECT DISTINCT dataset FROM messages_crdt WHERE timestamp > ?',
          [latestTimestamp],
        );

        // Only send the sync event if anybody else is connected
        if (connection.getNumClients() > 1) {
          connection.send('sync-event', {
            type: 'success',
            tables: rows.map(row => row.dataset),
          });
        }

        return result;
      },
      { undoDisabled: true },
    );
  };
}

let handlers = {} as unknown as Handlers;

async function validateMonth(month, budgetId?: string) {
  if (!month.match(/^\d{4}-\d{2}$/)) {
    throw APIError('Invalid month format, use YYYY-MM: ' + month);
  }

  if (!IMPORT_MODE) {
    const resolvedBudgetId = await resolveBudgetId(budgetId);
    const { start, end } = await handlers['get-budget-bounds']({
      budgetId: resolvedBudgetId,
    });
    const range = monthUtils.range(start, end);
    if (!range.includes(month)) {
      throw APIError('No budget exists for month: ' + month);
    }
  }
}

async function validateExpenseCategory(debug, id) {
  if (id == null) {
    throw APIError(`${debug}: category id is required`);
  }

  const row = await db.first<Pick<db.DbCategory, 'is_income'>>(
    'SELECT is_income FROM categories WHERE id = ?',
    [id],
  );

  if (!row) {
    throw APIError(`${debug}: category "${id}" does not exist`);
  }

  if (row.is_income !== 0) {
    throw APIError(`${debug}: category "${id}" is not an expense category`);
  }
}

function checkFileOpen() {
  if (!(prefs.getPrefs() || {}).id) {
    throw APIError('No budget file is open');
  }
}

let batchPromise = null;

handlers['api/batch-budget-start'] = async function () {
  if (batchPromise) {
    throw APIError('Cannot start a batch process: batch already started');
  }

  // If we are importing, all we need to do is start a raw database
  // transaction. Updating spreadsheet cells doesn't go through the
  // syncing layer in that case.
  if (IMPORT_MODE) {
    void db.asyncTransaction(() => {
      return new Promise((resolve, reject) => {
        batchPromise = { resolve, reject };
      });
    });
  } else {
    void batchMessages(() => {
      return new Promise((resolve, reject) => {
        batchPromise = { resolve, reject };
      });
    });
  }
};

handlers['api/batch-budget-end'] = async function () {
  if (!batchPromise) {
    throw APIError('Cannot end a batch process: no batch started');
  }

  batchPromise.resolve();
  batchPromise = null;
};

handlers['api/load-budget'] = async function ({ id }) {
  const { id: currentId } = prefs.getPrefs() || {};

  if (currentId !== id) {
    connection.send('start-load');
    const { error } = await handlers['load-budget']({ id });

    if (!error) {
      connection.send('finish-load');
    } else {
      connection.send('show-budgets');

      throw withErrorCode(new Error(getSyncError(error, id)), error);
    }
  }
};

handlers['api/download-budget'] = async function ({ syncId, password }) {
  const { id: currentId } = prefs.getPrefs() || {};
  if (currentId) {
    await handlers['close-budget']();
  }

  const budgets = await handlers['get-budgets']();
  const localBudget = budgets.find(b => b.groupId === syncId);
  let remoteBudget: RemoteFile;

  // Load a remote file if we could not find the file locally
  if (!localBudget) {
    const files = await handlers['get-remote-files']();
    if (!files) {
      throw withErrorCode(
        new Error('Could not get remote files'),
        'network-failure',
      );
    }
    const file = files.find(f => f.groupId === syncId);
    if (!file) {
      throw withErrorCode(
        new Error(
          `Budget "${syncId}" not found. Check the sync id of your budget in the Advanced section of the settings page.`,
        ),
        'budget-not-found',
      );
    }

    remoteBudget = file;
  }

  const activeFile = remoteBudget ? remoteBudget : localBudget;

  // Set the e2e encryption keys
  if (activeFile.encryptKeyId) {
    if (!password) {
      throw withErrorCode(
        new Error(
          `File ${activeFile.name} is encrypted. Please provide a password.`,
        ),
        'missing-key',
      );
    }

    const result = await handlers['key-test']({
      cloudFileId: remoteBudget ? remoteBudget.fileId : localBudget.cloudFileId,
      password,
    });
    if (result.error) {
      throw withErrorCode(
        new Error(getTestKeyError(result.error)),
        result.error.reason,
      );
    }
  }

  // Sync the local budget file
  if (localBudget) {
    await handlers['load-budget']({ id: localBudget.id });
    const result = await handlers['sync-budget']();
    if (result.error) {
      throw withErrorCode(
        new Error(
          getSyncError(result.error.reason, localBudget.id, result.error.meta),
        ),
        result.error.reason,
      );
    }
    return;
  }

  // Download the remote file (no need to perform a sync as the file will already be up-to-date)
  const result = await handlers['download-budget']({
    cloudFileId: remoteBudget.fileId,
  });
  if (result.error) {
    logger.log('Full error details', result.error);
    throw withErrorCode(
      new Error(getDownloadError(result.error)),
      result.error.reason,
    );
  }
  await handlers['load-budget']({ id: result.id });
};

handlers['api/get-budgets'] = async function () {
  const budgets = await handlers['get-budgets']();
  const files = (await handlers['get-remote-files']()) || [];
  return [
    ...budgets.map(file => budgetModel.toExternal(file)),
    ...files.map(file => remoteFileModel.toExternal(file)).filter(file => file),
  ];
};

handlers['api/sync'] = async function () {
  const { id } = prefs.getPrefs();
  const result = await handlers['sync-budget']();
  if (result.error) {
    throw withErrorCode(
      new Error(getSyncError(result.error.reason, id, result.error.meta)),
      result.error.reason,
    );
  }
};

handlers['api/bank-sync'] = async function (args) {
  const batchSync = args?.accountId == null;
  const allErrors = [];

  if (!batchSync) {
    const { errors } = await handlers['accounts-bank-sync']({
      ids: [args.accountId],
    });

    allErrors.push(...errors);
  } else {
    const accountsData = await db.getAllAccounts();
    const accountIdsToSync = accountsData.map(a => a.id);
    const simpleFinAccounts = accountsData.filter(
      a => a.account_sync_source === 'simpleFin',
    );
    const simpleFinAccountIds = simpleFinAccounts.map(a => a.id);

    if (simpleFinAccounts.length >= 1) {
      const res = await handlers['simplefin-batch-sync']({
        ids: simpleFinAccountIds,
      });

      res.forEach(a => allErrors.push(...a.res.errors));
    }

    const { errors } = await handlers['accounts-bank-sync']({
      ids: accountIdsToSync.filter(a => !simpleFinAccountIds.includes(a)),
    });

    allErrors.push(...errors);
  }

  const errors = allErrors.filter(e => e != null);
  if (errors.length > 0) {
    throw withErrorCode(new Error(getBankSyncError(errors[0])), errors[0].code);
  }
};

handlers['api/start-import'] = async function ({ budgetName }) {
  // Notify UI to close budget
  await handlers['close-budget']();

  // Create the budget
  await handlers['create-budget']({ budgetName, avoidUpload: true });

  // Clear out the default expense categories
  db.runQuery('DELETE FROM categories WHERE is_income = 0');
  db.runQuery('DELETE FROM category_groups WHERE is_income = 0');

  // Turn syncing off
  setSyncingMode('import');

  connection.send('start-import');
  IMPORT_MODE = true;
};

handlers['api/finish-import'] = async function () {
  checkFileOpen();

  sheet.get().markCacheDirty();

  // We always need to fully reload the app. Importing doesn't touch
  // the spreadsheet, but we can't just recreate the spreadsheet
  // either; there is other internal state that isn't created
  const { id } = prefs.getPrefs();
  await handlers['close-budget']();
  await handlers['load-budget']({ id });

  await handlers['get-budget-bounds']({ budgetId: 'default' });
  await sheet.waitOnSpreadsheet();

  await cloudStorage.upload().catch(err => {
    logger.warn('cloudStorage.upload failed during finish-import', err);
  });

  connection.send('finish-import');
  IMPORT_MODE = false;
};

handlers['api/abort-import'] = async function () {
  if (IMPORT_MODE) {
    checkFileOpen();

    const { id } = prefs.getPrefs();

    await handlers['close-budget']();
    await handlers['delete-budget']({ id });
    connection.send('show-budgets');
  }

  IMPORT_MODE = false;
};

handlers['api/query'] = async function ({ query }) {
  checkFileOpen();
  return aqlQuery(query);
};

handlers['api/budget-months'] = async function ({ budgetId } = {}) {
  checkFileOpen();
  const resolvedBudgetId = await resolveBudgetId(budgetId);
  const { start, end } = await handlers['get-budget-bounds']({
    budgetId: resolvedBudgetId,
  });
  return monthUtils.range(start, end);
};

handlers['api/budget-month'] = async function ({ budgetId, month }) {
  checkFileOpen();
  const resolvedBudgetId = await resolveBudgetId(budgetId);
  await validateMonth(month, resolvedBudgetId);

  const { data: groups }: { data: CategoryGroupEntity[] } = await aqlQuery(
    q('category_groups').filter({ budget_id: resolvedBudgetId }).select('*'),
  );
  const sheetName = monthUtils.sheetForMonth(resolvedBudgetId, month);

  function value(name) {
    const v = sheet.get().getCellValue(sheetName, name);
    return v === '' ? 0 : v;
  }

  // This is duplicated from main.js because the return format is
  // different (for now)
  return {
    month,
    incomeAvailable: value('available-funds') as number,
    lastMonthOverspent: value('last-month-overspent') as number,
    forNextMonth: value('buffered') as number,
    totalBudgeted: value('total-budgeted') as number,
    toBudget: value('to-budget') as number,

    fromLastMonth: value('from-last-month') as number,
    totalIncome: value('total-income') as number,
    totalSpent: value('total-spent') as number,
    totalBalance: value('total-leftover') as number,

    categoryGroups: groups.map(group => {
      if (group.is_income) {
        if (isTrackingBudget(resolvedBudgetId)) {
          return {
            ...categoryGroupModel.toExternal(group),
            budgeted: value(`group-budget-${group.id}`),
            received: value(`group-sum-amount-${group.id}`),
            balance: value(`group-leftover-${group.id}`),

            categories: group.categories.map(cat => ({
              ...categoryModel.toExternal(cat),
              budgeted: value(`budget-${cat.id}`),
              received: value(`sum-amount-${cat.id}`),
              balance: value(`leftover-${cat.id}`),
              carryover: value(`carryover-${cat.id}`),
            })),
          };
        }

        return {
          ...categoryGroupModel.toExternal(group),
          received: value('total-income'),

          categories: group.categories.map(cat => ({
            ...categoryModel.toExternal(cat),
            received: value(`sum-amount-${cat.id}`),
          })),
        };
      }

      return {
        ...categoryGroupModel.toExternal(group),
        budgeted: value(`group-budget-${group.id}`),
        spent: value(`group-sum-amount-${group.id}`),
        balance: value(`group-leftover-${group.id}`),

        categories: group.categories.map(cat => ({
          ...categoryModel.toExternal(cat),
          budgeted: value(`budget-${cat.id}`),
          spent: value(`sum-amount-${cat.id}`),
          balance: value(`leftover-${cat.id}`),
          carryover: value(`carryover-${cat.id}`),
        })),
      };
    }),
  };
};

handlers['api/budget-set-amount'] = withMutation(async function ({
  budgetId,
  month,
  categoryId,
  amount,
}) {
  checkFileOpen();
  const resolvedBudgetId = await resolveBudgetId(budgetId);
  return handlers['budget/budget-amount']({
    budgetId: resolvedBudgetId,
    month,
    category: categoryId,
    amount,
  });
});

handlers['api/budget-set-carryover'] = withMutation(async function ({
  budgetId,
  month,
  categoryId,
  flag,
}) {
  checkFileOpen();
  const resolvedBudgetId = await resolveBudgetId(budgetId);
  await validateMonth(month, resolvedBudgetId);
  await validateExpenseCategory('budget-set-carryover', categoryId);
  return handlers['budget/set-carryover']({
    budgetId: resolvedBudgetId,
    startMonth: month,
    category: categoryId,
    flag,
  });
});

handlers['api/budget-hold-for-next-month'] = withMutation(async function ({
  budgetId,
  month,
  amount,
}) {
  checkFileOpen();
  const resolvedBudgetId = await resolveBudgetId(budgetId);
  await validateMonth(month, resolvedBudgetId);
  if (amount <= 0) {
    throw APIError('Amount to hold needs to be greater than 0');
  }
  return handlers['budget/hold-for-next-month']({
    budgetId: resolvedBudgetId,
    month,
    amount,
  });
});

handlers['api/budget-reset-hold'] = withMutation(async function ({
  budgetId,
  month,
}) {
  checkFileOpen();
  const resolvedBudgetId = await resolveBudgetId(budgetId);
  await validateMonth(month, resolvedBudgetId);
  return handlers['budget/reset-hold']({ budgetId: resolvedBudgetId, month });
});

handlers['api/transactions-export'] = async function ({
  transactions,
  categoryGroups,
  payees,
  accounts,
}) {
  checkFileOpen();
  return handlers['transactions-export']({
    transactions,
    categoryGroups,
    payees,
    accounts,
  });
};

handlers['api/transactions-import'] = withMutation(async function ({
  accountId,
  transactions,
  isPreview = false,
  opts,
}) {
  checkFileOpen();
  return handlers['transactions-import']({
    accountId,
    transactions,
    isPreview,
    opts,
  });
});

handlers['api/transactions-add'] = withMutation(async function ({
  accountId,
  transactions,
  runTransfers = false,
  learnCategories = false,
}) {
  checkFileOpen();
  await addTransactions(accountId, transactions, {
    runTransfers,
    learnCategories,
  });
  return 'ok' as const;
});

handlers['api/transactions-get'] = async function ({
  accountId,
  startDate,
  endDate,
}) {
  checkFileOpen();
  const { data } = await aqlQuery(
    q('transactions')
      .filter({
        $and: [
          accountId && { account: accountId },
          startDate && { date: { $gte: startDate } },
          endDate && { date: { $lte: endDate } },
        ].filter(Boolean),
      })
      .select('*')
      .options({ splits: 'grouped' }),
  );
  return data;
};

handlers['api/transaction-update'] = withMutation(async function ({
  id,
  fields,
}) {
  checkFileOpen();
  const { data } = await aqlQuery(
    q('transactions').filter({ id }).select('*').options({ splits: 'grouped' }),
  );
  const transactions = ungroupTransactions(data);

  if (transactions.length === 0) {
    return [];
  }

  // @ts-expect-error - fix me
  const { diff } = updateTransaction(transactions, { id, ...fields });
  return handlers['transactions-batch-update'](diff)['updated'];
});

handlers['api/transaction-delete'] = withMutation(async function ({ id }) {
  checkFileOpen();
  const { data } = await aqlQuery(
    q('transactions').filter({ id }).select('*').options({ splits: 'grouped' }),
  );
  const transactions = ungroupTransactions(data);

  if (transactions.length === 0) {
    return [];
  }

  const { diff } = deleteTransaction(transactions, id);
  return handlers['transactions-batch-update'](diff)['deleted'];
});

handlers['api/transactions-merge'] = withMutation(async function ({ ids }) {
  checkFileOpen();
  return handlers['transactions-merge'](ids.map(id => ({ id })));
});

handlers['api/accounts-get'] = async function ({ budgetId } = {}) {
  checkFileOpen();
  const owner = await resolveBudgetId(budgetId);
  const accounts: AccountEntity[] = await handlers['accounts-get']({
    budgetId: owner,
  });
  return accounts.map(account => accountModel.toExternal(account));
};

handlers['api/account-create'] = withMutation(async function ({
  account,
  initialBalance = null,
  budgetId,
}) {
  checkFileOpen();
  if ('budget_id' in account) {
    throw APIError("Field 'budget_id' cannot be set when creating an account");
  }
  const owner = await resolveBudgetId(budgetId);
  const decimalPlaces = await getBudgetDecimalPlaces(owner);
  return handlers['account-create']({
    budgetId: owner,
    name: account.name,
    offBudget: account.offbudget,
    closed: account.closed,
    // Current the API expects an amount but it really should expect
    // an integer
    balance:
      initialBalance != null
        ? integerToAmount(initialBalance, decimalPlaces)
        : null,
  });
});

handlers['api/account-update'] = withMutation(async function ({ id, fields }) {
  checkFileOpen();
  const { id: _ignoredId, name, account_group_id, ...rest } = fields;

  const hints: Record<string, string> = {
    closed: "Use closeAccount/reopenAccount to change 'closed'",
    offbudget: "Field 'offbudget' cannot be updated",
  };
  const rejected = Object.keys(rest);
  if (rejected.length > 0) {
    throw APIError(
      rejected
        .map(field => hints[field] ?? `Field '${field}' cannot be updated`)
        .join('; '),
    );
  }

  if (name !== undefined || account_group_id !== undefined) {
    await handlers['account-update']({
      id,
      ...(name !== undefined && { name }),
      ...(account_group_id !== undefined && { account_group_id }),
    });
  }
});

handlers['api/account-close'] = withMutation(async function ({
  id,
  transferAccountId,
  transferCategoryId,
}) {
  checkFileOpen();
  return handlers['account-close']({
    id,
    transferAccountId,
    categoryId: transferCategoryId,
  });
});

handlers['api/account-reopen'] = withMutation(async function ({ id }) {
  checkFileOpen();
  return handlers['account-reopen']({ id });
});

handlers['api/account-delete'] = withMutation(async function ({ id }) {
  checkFileOpen();
  return handlers['account-close']({ id, forced: true });
});

handlers['api/account-balance'] = withMutation(async function ({
  id,
  cutoff = new Date(),
}) {
  checkFileOpen();
  return handlers['account-balance']({ id, cutoff });
});

handlers['api/account-groups-get'] = async function ({ budgetId } = {}) {
  checkFileOpen();
  const owner = await resolveBudgetId(budgetId);
  const groups = await handlers['account-groups-get']({ budgetId: owner });
  return groups.map(group => accountGroupModel.toExternal(group));
};

handlers['api/account-group-create'] = withMutation(async function ({
  group,
  budgetId,
}) {
  checkFileOpen();
  if ('budget_id' in group) {
    throw APIError(
      "Field 'budget_id' cannot be set when creating an account group",
    );
  }
  const owner = await resolveBudgetId(budgetId);
  return handlers['account-group-create']({
    name: group.name,
    budgetId: owner,
  });
});

handlers['api/account-group-update'] = withMutation(async function ({
  id,
  fields,
}) {
  checkFileOpen();
  const group = accountGroupModel.fromExternal(fields);
  if (group.name == null) {
    throw APIError('Account group name is required');
  }
  return handlers['account-group-update']({ id, name: group.name });
});

handlers['api/account-group-delete'] = withMutation(async function ({ id }) {
  checkFileOpen();
  await handlers['account-group-delete']({ id });
});

handlers['api/categories-get'] = async function ({
  hidden,
  budgetId,
}: { hidden?: boolean; budgetId?: string } = {}) {
  checkFileOpen();
  const owner = await resolveBudgetId(budgetId);
  const result = await handlers['get-categories']({ hidden, budgetId: owner });
  return result.list.map(category => categoryModel.toExternal(category));
};

handlers['api/category-groups-get'] = async function ({
  hidden,
  budgetId,
}: { hidden?: boolean; budgetId?: string } = {}) {
  checkFileOpen();
  const owner = await resolveBudgetId(budgetId);
  const groups = await handlers['get-category-groups']({
    hidden,
    budgetId: owner,
  });
  return groups.map(group => categoryGroupModel.toExternal(group));
};

handlers['api/category-group-create'] = withMutation(async function ({
  group,
  budgetId,
}) {
  checkFileOpen();
  if ('budget_id' in group) {
    throw APIError(
      "Field 'budget_id' cannot be set when creating a category group",
    );
  }
  const owner = await resolveBudgetId(budgetId);
  return handlers['category-group-create']({
    budgetId: owner,
    name: group.name,
    hidden: group.hidden,
  });
});

handlers['api/category-group-update'] = withMutation(async function ({
  id,
  fields,
}) {
  checkFileOpen();
  return handlers['category-group-update']({
    id,
    // @ts-expect-error - fix me
    ...categoryGroupModel.fromExternal(fields),
  });
});

handlers['api/category-group-delete'] = withMutation(async function ({
  id,
  transferCategoryId,
}) {
  checkFileOpen();
  return handlers['category-group-delete']({
    id,
    transferId: transferCategoryId,
  });
});

handlers['api/category-create'] = withMutation(async function ({
  category,
  budgetId,
}) {
  checkFileOpen();
  if ('budget_id' in category) {
    throw APIError("Field 'budget_id' cannot be set when creating a category");
  }
  const owner = await resolveBudgetId(budgetId);
  return handlers['category-create']({
    budgetId: owner,
    name: category.name,
    groupId: category.group_id,
    isIncome: category.is_income,
    hidden: category.hidden,
  });
});

handlers['api/category-update'] = withMutation(async function ({ id, fields }) {
  checkFileOpen();
  return handlers['category-update']({
    id,
    // @ts-expect-error - fix me
    ...categoryModel.fromExternal(fields),
  });
});

handlers['api/category-delete'] = withMutation(async function ({
  id,
  transferCategoryId,
}) {
  checkFileOpen();
  return handlers['category-delete']({
    id,
    transferId: transferCategoryId,
  });
});

handlers['api/note-get'] = async function ({ id }) {
  checkFileOpen();
  return handlers['notes-get']({ id });
};

handlers['api/note-update'] = withMutation(async function ({ id, note }) {
  checkFileOpen();
  return handlers['notes-save']({ id, note });
});

handlers['api/common-payees-get'] = async function () {
  checkFileOpen();
  const payees = await handlers['common-payees-get']();
  return payees.map(payee => payeeModel.toExternal(payee));
};

handlers['api/payees-get'] = async function () {
  checkFileOpen();
  const payees = await handlers['payees-get']();
  return payees.map(payee => payeeModel.toExternal(payee));
};

handlers['api/payee-create'] = withMutation(async function ({ payee }) {
  checkFileOpen();
  return handlers['payee-create']({ name: payee.name });
});

handlers['api/payee-update'] = withMutation(async function ({ id, fields }) {
  checkFileOpen();
  return handlers['payees-batch-change']({
    // @ts-expect-error - fix me
    updated: [{ id, ...payeeModel.fromExternal(fields) }],
  });
});

handlers['api/payee-delete'] = withMutation(async function ({ id }) {
  checkFileOpen();
  return handlers['payees-batch-change']({ deleted: [{ id }] });
});

handlers['api/payees-merge'] = withMutation(async function ({
  targetId,
  mergeIds,
}) {
  checkFileOpen();
  return handlers['payees-merge']({ targetId, mergeIds });
});

handlers['api/tags-get'] = async function () {
  checkFileOpen();
  const tags = await handlers['tags-get']();
  return tags.map(tag => tagModel.toExternal(tag));
};

handlers['api/tag-create'] = withMutation(async function ({ tag }) {
  checkFileOpen();
  const result = await handlers['tags-create']({
    tag: tag.tag,
    color: tag.color,
    description: tag.description,
  });
  return result.id;
});

handlers['api/tag-update'] = withMutation(async function ({ id, fields }) {
  checkFileOpen();
  await handlers['tags-update']({ id, ...tagModel.fromExternal(fields) });
});

handlers['api/tag-delete'] = withMutation(async function ({ id }) {
  checkFileOpen();
  await handlers['tags-delete']({ id });
});

handlers['api/payee-location-create'] = withMutation(async function ({
  payeeId,
  latitude,
  longitude,
}) {
  checkFileOpen();
  return handlers['payee-location-create']({ payeeId, latitude, longitude });
});

handlers['api/payee-locations-get'] = async function ({ payeeId }) {
  checkFileOpen();
  return handlers['payee-locations-get']({ payeeId });
};

handlers['api/payee-location-delete'] = withMutation(async function ({ id }) {
  checkFileOpen();
  return handlers['payee-location-delete']({ id });
});

handlers['api/payees-get-nearby'] = async function ({
  latitude,
  longitude,
  maxDistance,
}) {
  checkFileOpen();
  return handlers['payees-get-nearby']({ latitude, longitude, maxDistance });
};

handlers['api/rules-get'] = async function ({ budgetId } = {}) {
  checkFileOpen();
  return handlers['rules-get']({ budgetId: await resolveBudgetId(budgetId) });
};

handlers['api/payee-rules-get'] = async function ({ id, budgetId }) {
  checkFileOpen();
  return handlers['payees-get-rules']({
    id,
    budgetId: await resolveBudgetId(budgetId),
  });
};

handlers['api/rule-create'] = withMutation(async function ({ rule, budgetId }) {
  checkFileOpen();
  if ('budget_id' in rule) {
    throw APIError("Field 'budget_id' cannot be set when creating a rule");
  }
  const owner = await resolveBudgetId(budgetId);
  const addedRule = await handlers['rule-add'](
    ruleModel.fromExternal(rule, owner),
  );

  if ('error' in addedRule) {
    throw APIError('Failed creating a new rule', addedRule.error);
  }

  return addedRule;
});

handlers['api/rule-update'] = withMutation(async function ({ rule }) {
  checkFileOpen();
  const budgetId = await getBudgetIdForEntity({ table: 'rules', id: rule.id });
  if ('budget_id' in rule && rule.budget_id !== budgetId) {
    throw APIError('Rule ownership cannot be changed');
  }
  const updatedRule = await handlers['rule-update'](
    ruleModel.fromExternal(rule, budgetId),
  );

  if ('error' in updatedRule) {
    throw APIError('Failed updating the rule', updatedRule.error);
  }

  return updatedRule;
});

handlers['api/rule-delete'] = withMutation(async function ({ id, budgetId }) {
  checkFileOpen();
  return handlers['rule-delete']({
    id,
    budgetId: await resolveBudgetId(budgetId),
  });
});

handlers['api/schedules-get'] = async function ({ budgetId } = {}) {
  checkFileOpen();
  const owner = await resolveBudgetId(budgetId);
  const { data } = await aqlQuery(
    q('schedules').filter({ budget_id: owner }).select('*'),
  );
  const schedules = data as ScheduleEntity[];
  return schedules.map(schedule => scheduleModel.toExternal(schedule));
};

handlers['api/schedule-create'] = withMutation(async function (
  input:
    | Omit<APIScheduleEntity, 'id'>
    | { schedule: Omit<APIScheduleEntity, 'id'>; budgetId?: string },
) {
  checkFileOpen();
  const isWrappedInput = 'schedule' in input;
  const schedule = isWrappedInput ? input.schedule : input;
  const budgetId = isWrappedInput ? input.budgetId : undefined;
  const owner = await resolveBudgetId(budgetId);
  const internalSchedule = scheduleModel.fromExternal(
    { ...schedule, id: '' },
    owner,
  );
  const partialSchedule = {
    name: internalSchedule.name,
    posts_transaction: internalSchedule.posts_transaction,
  };
  return handlers['schedule/create']({
    budgetId: owner,
    schedule: partialSchedule,
    conditions: internalSchedule._conditions,
  });
});

handlers['api/schedule-update'] = withMutation(async function ({
  id,
  fields,
  resetNextDate,
}) {
  checkFileOpen();
  const { data } = await aqlQuery(q('schedules').filter({ id }).select('*'));
  if (!data || data.length === 0) {
    throw APIError(`Schedule ${id} not found`);
  }

  const sched = data[0] as ScheduleEntity;
  let conditionsUpdated = false;
  // Find all indices to avoid direct assignment
  const payeeIndex = sched._conditions.findIndex(c => c.field === 'payee');
  const accountIndex = sched._conditions.findIndex(c => c.field === 'account');
  const dateIndex = sched._conditions.findIndex(c => c.field === 'date');
  const amountIndex = sched._conditions.findIndex(c => c.field === 'amount');

  for (const key in fields) {
    const typedKey = key as keyof APIScheduleEntity;
    const value = fields[typedKey];

    switch (typedKey) {
      case 'name': {
        const newName = String(value);
        const { data: existing } = await aqlQuery(
          q('schedules')
            .filter({ name: newName, budget_id: sched.budget_id })
            .select('*'),
        );
        if (!existing || existing.length === 0 || existing[0].id === sched.id) {
          sched.name = newName;
          conditionsUpdated = true;
        } else {
          throw APIError(`There is already a schedule named: ${newName}`);
        }
        break;
      }
      case 'next_date':
      case 'completed': {
        throw APIError(
          `Field ${typedKey} is system-managed and not user-editable.`,
        );
      }
      case 'posts_transaction': {
        sched.posts_transaction = Boolean(value);
        conditionsUpdated = true;
        break;
      }
      case 'payee': {
        if (payeeIndex !== -1) {
          sched._conditions[payeeIndex].value = value;
          conditionsUpdated = true;
        } else {
          sched._conditions.push({
            field: 'payee',
            op: 'is',
            value: String(value),
          });
          conditionsUpdated = true;
        }
        break;
      }
      case 'account': {
        if (accountIndex !== -1) {
          sched._conditions[accountIndex].value = value;
          conditionsUpdated = true;
        } else {
          sched._conditions.push({
            field: 'account',
            op: 'is',
            value: String(value),
          });
          conditionsUpdated = true;
        }
        break;
      }
      case 'amountOp': {
        if (amountIndex !== -1) {
          let convertedOp: AmountOPType;
          switch (value) {
            case 'is':
              convertedOp = 'is';
              break;
            case 'isapprox':
              convertedOp = 'isapprox';
              break;
            case 'isbetween':
              convertedOp = 'isbetween';
              break;
            default:
              throw APIError(
                `Invalid amount operator: ${String(value)}. Expected: is, isapprox, or isbetween`,
              );
          }
          sched._conditions[amountIndex].op = convertedOp;
          conditionsUpdated = true;
        } else {
          throw APIError(`Ammount can not be found. There is a bug here`);
        }
        break;
      }
      case 'amount': {
        if (amountIndex !== -1) {
          sched._conditions[amountIndex].value = value;
          conditionsUpdated = true;
        } else {
          throw APIError(`Ammount can not be found. There is a bug here`);
        }
        break;
      }
      case 'date': {
        if (dateIndex !== -1) {
          sched._conditions[dateIndex].value = value;
          conditionsUpdated = true;
        } else {
          throw APIError(
            `Date can not be found. Schedules can not be created without a date there is a bug here`,
          );
        }
        break;
      }
      default: {
        throw APIError(`Unhandled field: ${typedKey}`);
      }
    }
  }

  if (conditionsUpdated) {
    return handlers['schedule/update']({
      schedule: {
        id: sched.id,
        posts_transaction: sched.posts_transaction,
        name: sched.name,
      },
      conditions: sched._conditions,
      resetNextDate,
    });
  } else {
    return sched.id;
  }
});

handlers['api/schedule-delete'] = withMutation(async function ({
  id,
  budgetId,
}: {
  id: string;
  budgetId?: string;
}) {
  checkFileOpen();
  const owner = await resolveBudgetId(budgetId);
  await assertBudgetOwner(owner, [{ table: 'schedules', id }]);
  return handlers['schedule/delete']({ id });
});

handlers['api/get-id-by-name'] = async function ({ type, name, budgetId }) {
  checkFileOpen();

  const allowedTypes = ['payees', 'categories', 'schedules', 'accounts'];

  if (!allowedTypes.includes(type)) {
    throw APIError('Provide a valid type');
  }

  const owner = type === 'payees' ? undefined : await resolveBudgetId(budgetId);
  const { data } = await aqlQuery(
    q(type)
      .filter({ name, ...(owner ? { budget_id: owner } : {}) })
      .select('*'),
  );

  if (!data || data.length === 0) {
    throw APIError(`Not found: ${type} with name ${name}`);
  }

  return data[0].id;
};

handlers['api/get-server-version'] = async function () {
  return handlers['get-server-version']();
};

export function installAPI(serverHandlers: ServerHandlers) {
  const merged = Object.assign({}, serverHandlers, handlers);
  handlers = merged as Handlers;
  return merged;
}
