// @ts-strict-ignore
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import {
  assertBudgetOwner,
  getBudgetIdForEntity,
  validateBudgetExists,
} from '#server/budget-spaces/helpers';
import * as db from '#server/db';
import {
  ValidationError as BudgetValidationError,
  RuleError,
} from '#server/errors';
import { mutator } from '#server/mutators';
import { batchMessages } from '#server/sync';
import * as rules from '#server/transactions/transaction-rules';
import { undoable } from '#server/undo';
import type {
  RuleActionEntity,
  RuleEntity,
  TransactionEntity,
} from '#types/models';

import { Action, Condition, rankRules } from '.';

function validateRule(rule: Partial<RuleEntity>) {
  // Returns an array of errors, the array is the same link as the
  // passed-in `array`, or null if there are no errors
  function runValidation<T>(array: T[], validate: (item: T) => unknown) {
    const result = array.map(item => {
      try {
        validate(item);
      } catch (e) {
        if (e instanceof RuleError) {
          logger.warn('Invalid rule', e);
          return e.type;
        }
        throw e;
      }
      return null;
    });

    return result.filter((res): res is string => typeof res === 'string').length
      ? result
      : null;
  }

  const conditionErrors = runValidation(
    rule.conditions,
    cond => new Condition(cond.op, cond.field, cond.value, cond.options),
  );

  const actionErrors = runValidation(rule.actions, action =>
    action.op === 'delete-transaction'
      ? new Action(action.op, null, null, null)
      : action.op === 'set-split-amount'
        ? new Action(action.op, null, action.value, action.options)
        : action.op === 'link-schedule'
          ? new Action(action.op, null, action.value, null)
          : action.op === 'prepend-notes' || action.op === 'append-notes'
            ? new Action(action.op, null, action.value, null)
            : new Action(action.op, action.field, action.value, action.options),
  );

  if (conditionErrors || actionErrors) {
    return {
      conditionErrors,
      actionErrors,
    };
  }

  return null;
}

type ValidationError = {
  conditionErrors: string[];
  actionErrors: string[];
};

export type RulesHandlers = {
  'rule-validate': typeof ruleValidate;
  'rule-add': typeof addRule;
  'rule-update': typeof updateRule;
  'rule-delete': typeof deleteRule;
  'rule-delete-all': typeof deleteAllRules;
  'rule-apply-actions': typeof applyRuleActions;
  'rule-add-payee-rename': typeof addRulePayeeRename;
  'rules-get': typeof getRules;
  'rule-get': typeof getRule;
  'rules-run': typeof runRules;
};

// Expose functions to the client
export const app = createApp<RulesHandlers>();

app.method('rule-validate', ruleValidate);
app.method('rule-add', mutator(addRule));
app.method('rule-update', mutator(undoable(updateRule)));
app.method('rule-delete', mutator(undoable(deleteRule)));
app.method('rule-delete-all', mutator(undoable(deleteAllRules)));
app.method('rule-apply-actions', mutator(undoable(applyRuleActions)));
app.method('rule-add-payee-rename', mutator(addRulePayeeRename));
app.method('rules-get', getRules);
app.method('rule-get', getRule);
app.method('rules-run', runRules);

async function ruleValidate(
  rule: Partial<RuleEntity>,
): Promise<{ error: ValidationError | null }> {
  const error = validateRule(rule);
  return { error };
}

async function validateRuleReferences(
  rule: RuleEntity | Omit<RuleEntity, 'id'>,
) {
  const references: Array<{
    table: 'accounts' | 'categories' | 'category_groups' | 'schedules';
    id: string;
  }> = [];
  for (const condition of rule.conditions ?? []) {
    const table =
      condition.field === 'account'
        ? 'accounts'
        : condition.field === 'category'
          ? 'categories'
          : condition.field === 'category_group'
            ? 'category_groups'
            : null;
    if (table) {
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
  }
  for (const action of rule.actions ?? []) {
    if (
      'field' in action &&
      action.field === 'payee' &&
      typeof action.value === 'string'
    ) {
      const transfer = await db.first<{ transfer_acct: string | null }>(
        'SELECT transfer_acct FROM payees WHERE id = ?',
        [action.value],
      );
      if (transfer?.transfer_acct) {
        references.push({ table: 'accounts', id: transfer.transfer_acct });
      }
    }
    const table =
      'field' in action && action.field === 'account'
        ? 'accounts'
        : 'field' in action && action.field === 'category'
          ? 'categories'
          : action.op === 'link-schedule'
            ? 'schedules'
            : null;
    if (table && typeof action.value === 'string' && action.value.length > 0) {
      references.push({ table, id: action.value });
    }
  }
  if (references.length > 0) {
    await assertBudgetOwner(rule.budget_id, references);
  }
}

async function addRule(
  rule: Omit<RuleEntity, 'id'>,
): Promise<{ error: ValidationError } | RuleEntity> {
  if (!rule.budget_id) {
    throw new BudgetValidationError('Budget ID is required to create a rule');
  }
  await validateBudgetExists(rule.budget_id);
  const error = validateRule(rule);
  if (error) {
    return { error };
  }
  await validateRuleReferences(rule);

  const id = await rules.insertRule(rule);
  return { id, ...rule };
}

async function updateRule(
  rule: RuleEntity,
): Promise<{ error: ValidationError } | RuleEntity> {
  const existing = rules.getRules().find(candidate => candidate.id === rule.id);
  if (!existing) {
    throw new BudgetValidationError(`Rule not found: ${rule.id}`);
  }
  if (rule.budget_id !== existing.budget_id) {
    throw new BudgetValidationError('Rule ownership cannot be changed');
  }
  const error = validateRule(rule);
  if (error) {
    return { error };
  }
  await validateRuleReferences(rule);

  await rules.updateRule(rule);
  return rule;
}

async function deleteRule({
  id,
  budgetId,
}: {
  id: RuleEntity['id'];
  budgetId: string;
}) {
  await assertBudgetOwner(budgetId, [{ table: 'rules', id }]);
  return rules.deleteRule(id);
}

async function deleteAllRules({
  ids,
  budgetId,
}: {
  ids: Array<RuleEntity['id']>;
  budgetId: string;
}): Promise<{ someDeletionsFailed: boolean }> {
  await validateBudgetExists(budgetId);
  const selectedRules = rules.getRules().filter(rule => ids.includes(rule.id));
  if (
    selectedRules.length !== ids.length ||
    selectedRules.some(rule => rule.budget_id !== budgetId)
  ) {
    throw new BudgetValidationError(
      'Rules must belong to the requested budget',
    );
  }
  let someDeletionsFailed = false;

  await batchMessages(async () => {
    for (const id of ids) {
      const res = await rules.deleteRule(id);
      if (res === false) {
        someDeletionsFailed = true;
      }
    }
  });

  return { someDeletionsFailed };
}

async function applyRuleActions({
  transactions,
  actions,
}: {
  transactions: TransactionEntity[];
  actions: Array<Action | RuleActionEntity>;
}): Promise<null | {
  added: TransactionEntity[];
  updated: unknown[];
  errors: string[];
}> {
  const owners = await Promise.all(
    transactions.map(transaction =>
      getBudgetIdForEntity({ table: 'transactions', id: transaction.id }),
    ),
  );
  if (new Set(owners).size > 1) {
    throw new BudgetValidationError(
      'Rule actions cannot be applied across multiple budgets',
    );
  }
  return rules.applyActions(transactions, actions);
}

async function addRulePayeeRename({
  fromNames,
  to,
  budgetId,
}: {
  fromNames: string[];
  to: string;
  budgetId: string;
}): Promise<string> {
  await validateBudgetExists(budgetId);
  return rules.updatePayeeRenameRule(fromNames, to, budgetId);
}

async function getRule({
  id,
}: {
  id: RuleEntity['id'];
}): Promise<RuleEntity | null> {
  const rule = rules.getRules().find(rule => rule.id === id);
  return rule ? rule.serialize() : null;
}

async function getRules({ budgetId }: { budgetId: string }) {
  await validateBudgetExists(budgetId);
  return rankRules(
    rules.getRules().filter(rule => rule.budget_id === budgetId),
  ).map(rule => rule.serialize());
}

async function runRules({
  transaction,
}: {
  transaction: TransactionEntity;
}): Promise<TransactionEntity> {
  return rules.runRules(transaction);
}
