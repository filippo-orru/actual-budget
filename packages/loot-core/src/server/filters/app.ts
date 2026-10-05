// @ts-strict-ignore
import { v4 as uuidv4 } from 'uuid';

import { createApp } from '#server/app';
import {
  assertBudgetOwner,
  getBudgetIdForEntity,
  validateBudgetExists,
} from '#server/budget-spaces/helpers';
import * as db from '#server/db';
import { requiredFields } from '#server/models';
import { mutator } from '#server/mutators';
import { parseConditionsOrActions } from '#server/transactions/transaction-rules';
import { undoable } from '#server/undo';
import type { TransactionFilterEntity } from '#types/models';

const filterModel = {
  validate(filter, { update }: { update?: boolean } = {}) {
    requiredFields('transaction_filters', filter, ['conditions'], update);

    if (!update || 'conditionsOp' in filter) {
      if (!['and', 'or'].includes(filter.conditionsOp)) {
        throw new Error('Invalid filter conditionsOp: ' + filter.conditionsOp);
      }
    }

    return filter;
  },

  toJS(row) {
    const { conditions, conditions_op, ...fields } = row;
    return {
      ...fields,
      conditionsOp: conditions_op,
      conditions: parseConditionsOrActions(conditions),
    };
  },

  fromJS(filter) {
    const { conditionsOp, ...row } = filter;
    if (conditionsOp) {
      row.conditions_op = conditionsOp;
    }
    return row;
  },
};

async function validateFilterReferences(conditions, budgetId: string) {
  const references: Array<{
    table: 'accounts' | 'categories' | 'category_groups';
    id: string;
  }> = [];
  for (const condition of conditions ?? []) {
    const table =
      condition.field === 'account'
        ? 'accounts'
        : condition.field === 'category'
          ? 'categories'
          : condition.field === 'category_group'
            ? 'category_groups'
            : null;
    if (!table) {
      continue;
    }
    const values =
      condition.op === 'oneOf' || condition.op === 'notOneOf'
        ? condition.value
        : [condition.value];
    for (const id of values ?? []) {
      if (typeof id === 'string' && id.length > 0) {
        references.push({ table, id });
      }
    }
  }
  if (references.length > 0) {
    await assertBudgetOwner(budgetId, references);
  }
}

async function filterNameExists(budgetId, name, filterId, newItem) {
  const idForName = await db.first<Pick<db.DbTransactionFilter, 'id'>>(
    'SELECT id from transaction_filters WHERE tombstone = 0 AND budget_id = ? AND name = ?',
    [budgetId, name],
  );

  if (idForName === null) {
    return false;
  }
  if (!newItem) {
    return idForName.id !== filterId;
  }
  return true;
}

function conditionExists(item, filters, newItem) {
  const { conditions, conditionsOp } = item;
  let fConditionFound = null;

  filters.some(filter => {
    if (
      (conditions.length === 1 || filter.conditionsOp === conditionsOp) &&
      !filter.tombstone &&
      filter.conditions.length === conditions.length
    ) {
      const allConditionsMatch = !conditions.some(
        cond =>
          !filter.conditions.some(
            fcond =>
              cond.value === fcond.value &&
              cond.op === fcond.op &&
              cond.field === fcond.field &&
              filterOptionsMatch(cond.options, fcond.options),
          ),
      );

      if (allConditionsMatch) {
        fConditionFound = filter;
        return true;
      }
    }
    return false;
  });

  if (!newItem) {
    return fConditionFound
      ? fConditionFound.id !== item.id
        ? fConditionFound.name
        : false
      : false;
  }

  return fConditionFound ? fConditionFound.name : false;
}

function filterOptionsMatch(options1, options2) {
  const opt1 = options1 ?? {};
  const opt2 = options2 ?? {};

  const keys1 = Object.keys(opt1);
  const keys2 = Object.keys(opt2);

  if (keys1.length !== keys2.length) {
    return false;
  }

  return keys1.every(key => opt1[key] === opt2[key]);
}

async function createFilter(filter): Promise<TransactionFilterEntity['id']> {
  const budgetId = filter.budgetId ?? filter.state.budget_id;
  if (!budgetId) {
    throw new Error('Budget ID is required to create a saved filter');
  }
  await validateBudgetExists(budgetId);
  const filterId = uuidv4();
  const item = {
    id: filterId,
    budget_id: budgetId,
    conditions: filter.state.conditions,
    conditionsOp: filter.state.conditionsOp,
    name: filter.state.name,
  };

  if (item.name) {
    if (await filterNameExists(budgetId, item.name, item.id, true)) {
      throw new Error('There is already a filter named ' + item.name);
    }
  } else {
    throw new Error('Filter name is required');
  }

  if (item.conditions.length > 0) {
    const condExists = conditionExists(item, filter.filters, true);
    if (condExists) {
      throw new Error(
        'Duplicate filter warning: conditions already exist. Filter name: ' +
          condExists,
      );
    }
  } else {
    throw new Error('Conditions are required');
  }

  await validateFilterReferences(item.conditions, budgetId);
  // Create the filter here based on the info
  await db.insertWithSchema('transaction_filters', filterModel.fromJS(item));

  return filterId;
}

async function updateFilter(filter) {
  const budgetId = await getBudgetIdForEntity({
    table: 'transaction_filters',
    id: filter.state.id,
  });
  const item = {
    id: filter.state.id,
    budget_id: budgetId,
    conditions: filter.state.conditions,
    conditionsOp: filter.state.conditionsOp,
    name: filter.state.name,
  };
  if (item.name) {
    if (await filterNameExists(budgetId, item.name, item.id, false)) {
      throw new Error('There is already a filter named ' + item.name);
    }
  } else {
    throw new Error('Filter name is required');
  }

  if (item.conditions.length > 0) {
    const condExists = conditionExists(item, filter.filters, false);
    if (condExists) {
      throw new Error(
        'Duplicate filter warning: conditions already exist. Filter name: ' +
          condExists,
      );
    }
  } else {
    throw new Error('Conditions are required');
  }

  await validateFilterReferences(item.conditions, budgetId);
  await db.updateWithSchema('transaction_filters', filterModel.fromJS(item));
}

async function deleteFilter(id: TransactionFilterEntity['id']) {
  await getBudgetIdForEntity({ table: 'transaction_filters', id });
  await db.delete_('transaction_filters', id);
}

export type FiltersHandlers = {
  'filter-create': typeof createFilter;
  'filter-update': typeof updateFilter;
  'filter-delete': typeof deleteFilter;
};

export const app = createApp<FiltersHandlers>();

app.method('filter-create', mutator(createFilter));
app.method('filter-update', mutator(updateFilter));
app.method('filter-delete', mutator(undoable(deleteFilter)));
