import * as db from '#server/db';
import type { DbAccount, DbCategory, DbCategoryGroup } from '#server/db';
import { ValidationError } from '#server/errors';
import type { TransactionEntity } from '#types/models';

type ProposedWriteSet = {
  sourceAccount: DbAccount;
  destinationAccountId: string;
  destinationBudgetId: string;
  destinationCategories: DbCategory[];
  destinationGroups: DbCategoryGroup[];
  categoryIds: string[];
  groupIds: string[];
  transactions: TransactionEntity[];
  sourceRows: TransactionEntity[];
  rules: Array<{
    budget_id: string;
    conditions: string;
    actions: string;
  }>;
};

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${name} must be a safe integer`);
  }
}

export async function validateMigrationWriteSet(
  proposal: ProposedWriteSet,
): Promise<void> {
  if (
    proposal.sourceRows.some(row => row.account !== proposal.sourceAccount.id)
  ) {
    throw new ValidationError(
      'The source transaction snapshot has invalid ownership',
    );
  }
  const accountCollision = await db.first<{ id: string }>(
    'SELECT id FROM accounts WHERE id = ? AND tombstone = 0',
    [proposal.destinationAccountId],
  );
  if (accountCollision) {
    throw new ValidationError(
      'The proposed destination account ID is already in use',
    );
  }

  const categories = new Set([
    ...proposal.destinationCategories.map(category => category.id),
    ...proposal.categoryIds,
  ]);
  const groups = new Set([
    ...proposal.destinationGroups.map(group => group.id),
    ...proposal.groupIds,
  ]);
  const transactions = new Map<string, TransactionEntity>();
  for (const transaction of proposal.transactions) {
    if (
      transaction.account !== proposal.destinationAccountId ||
      transaction.transfer_id ||
      transaction.schedule
    ) {
      throw new ValidationError(
        `Proposed transaction ${transaction.id} has an invalid account or link`,
      );
    }
    if (transactions.has(transaction.id)) {
      throw new ValidationError(
        `Duplicate proposed transaction ID: ${transaction.id}`,
      );
    }
    if (transaction.category && !categories.has(transaction.category)) {
      throw new ValidationError(
        `Proposed transaction ${transaction.id} references a category outside the destination`,
      );
    }
    assertSafeInteger(
      transaction.amount,
      `Transaction ${transaction.id} amount`,
    );
    transactions.set(transaction.id, transaction);
  }

  const childrenByParent = new Map<string, TransactionEntity[]>();
  for (const transaction of transactions.values()) {
    if (transaction.is_child && transaction.parent_id) {
      const children = childrenByParent.get(transaction.parent_id) ?? [];
      children.push(transaction);
      childrenByParent.set(transaction.parent_id, children);
    }
  }
  for (const transaction of transactions.values()) {
    if (transaction.is_child) {
      const parent = transaction.parent_id
        ? transactions.get(transaction.parent_id)
        : null;
      if (
        !parent ||
        !parent.is_parent ||
        parent.account !== transaction.account ||
        parent.date !== transaction.date
      ) {
        throw new ValidationError(
          `Proposed split child ${transaction.id} has an invalid parent`,
        );
      }
    }
    if (transaction.is_parent) {
      const children = childrenByParent.get(transaction.id) ?? [];
      if (children.length === 0) {
        throw new ValidationError(
          `Proposed split parent ${transaction.id} has no children`,
        );
      }
      const total = children.reduce((sum, child) => sum + child.amount, 0);
      assertSafeInteger(total, `Split ${transaction.id} total`);
      if (total !== transaction.amount) {
        throw new ValidationError(
          `Proposed split ${transaction.id} children do not equal the parent total`,
        );
      }
    }
  }

  for (const rule of proposal.rules) {
    if (rule.budget_id !== proposal.destinationBudgetId) {
      throw new ValidationError('A proposed rule has an invalid budget owner');
    }
    const conditions = JSON.parse(rule.conditions) as Array<
      Record<string, unknown>
    >;
    const actions = JSON.parse(rule.actions) as Array<Record<string, unknown>>;
    for (const condition of conditions) {
      if (condition.field === 'account') {
        if (
          ['is', 'isNot', 'oneOf', 'notOneOf'].includes(String(condition.op))
        ) {
          throw new ValidationError(
            'A proposed rule references a foreign account',
          );
        }
      }
      if (
        condition.field === 'category' ||
        condition.field === 'category_group'
      ) {
        const ids = Array.isArray(condition.value)
          ? condition.value
          : [condition.value];
        const allowed = condition.field === 'category' ? categories : groups;
        if (ids.some(id => typeof id !== 'string' || !allowed.has(id))) {
          throw new ValidationError(
            'A proposed rule references a foreign category',
          );
        }
      }
    }
    for (const action of actions) {
      if (
        action.op === 'link-schedule' ||
        action.field === 'account' ||
        (action.field === 'category' &&
          (typeof action.value !== 'string' || !categories.has(action.value)))
      ) {
        throw new ValidationError(
          'A proposed rule references a foreign budget entity',
        );
      }
    }
  }

  for (const category of proposal.destinationCategories) {
    if (!groups.has(category.cat_group)) {
      throw new ValidationError(
        `Proposed category ${category.id} references a group outside the destination`,
      );
    }
    if (category.budget_id !== proposal.destinationBudgetId) {
      throw new ValidationError(
        `Proposed category ${category.id} has an invalid budget owner`,
      );
    }
  }
}
