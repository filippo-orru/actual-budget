import { getBudgetIdForEntity } from '#server/budget-spaces/helpers';
import * as db from '#server/db';
import { ValidationError } from '#server/errors';
import type { TransactionEntity } from '#types/models';

type TransactionUpdate = Partial<TransactionEntity>;
type ValidatedTransaction = Omit<TransactionEntity, 'category'> & {
  category: TransactionEntity['category'] | null;
};

/** Validate the complete resulting ledger references before any transaction writes. */
export async function validateTransactionWrites({
  added = [],
  updated = [],
  pendingPayeeIds = new Set<string>(),
}: {
  added?: TransactionEntity[];
  updated?: TransactionUpdate[];
  pendingPayeeIds?: Set<string>;
}): Promise<ValidatedTransaction[]> {
  const addedIds = added.map(transaction => transaction.id);
  const updatedIds = updated.map(transaction => transaction.id);
  if (new Set(addedIds).size !== addedIds.length) {
    throw new ValidationError('Transaction batch contains duplicate added IDs');
  }
  if (new Set(updatedIds).size !== updatedIds.length) {
    throw new ValidationError(
      'Transaction batch contains duplicate updated IDs',
    );
  }
  if (addedIds.some(id => updatedIds.includes(id))) {
    throw new ValidationError(
      'Transaction ID cannot be both added and updated',
    );
  }

  const resulting = new Map<string, TransactionEntity>();

  for (const transaction of added) {
    if (Object.hasOwn(transaction, 'budget_id')) {
      throw new ValidationError(
        'Transaction ownership is derived from its account',
      );
    }
    if (
      await db.first<{ id: string }>(
        'SELECT id FROM transactions WHERE id = ?',
        [transaction.id],
      )
    ) {
      throw new ValidationError(
        `Transaction ID already exists: ${transaction.id}`,
      );
    }
    resulting.set(transaction.id, transaction);
  }

  for (const update of updated) {
    if (Object.hasOwn(update, 'budget_id')) {
      throw new ValidationError(
        'Transaction ownership is derived from its account',
      );
    }
    if (!update.id) {
      throw new ValidationError('Transaction ID is required for updates');
    }
    const stored = await db.getTransaction(update.id);
    if (!stored) {
      throw new ValidationError(`Transaction not found: ${update.id}`);
    }
    resulting.set(update.id, { ...stored, ...update });
  }

  const rows = [...resulting.values()];
  const ownerByAccount = new Map<string, string>();
  for (const transaction of rows) {
    const account = await db.first<
      Pick<db.DbAccount, 'id' | 'budget_id' | 'offbudget'>
    >(
      'SELECT id, budget_id, offbudget FROM accounts WHERE id = ? AND tombstone = 0',
      [transaction.account],
    );
    if (!account) {
      throw new ValidationError(
        `Transaction account not found: ${transaction.account}`,
      );
    }
    ownerByAccount.set(account.id, account.budget_id);

    const stored = await db.getTransaction(transaction.id);
    if (stored) {
      const oldOwner = await getBudgetIdForEntity({
        table: 'accounts',
        id: stored.account,
      });
      if (oldOwner !== account.budget_id) {
        throw new ValidationError('Transactions cannot move between budgets');
      }
    }

    // Preserve the existing normalization: parent and off-budget transactions
    // store no category, even when an input happens to carry one.
    const categoryId =
      transaction.is_parent || account.offbudget === 1
        ? null
        : transaction.category;
    if (categoryId == null) {
      delete transaction.category;
    } else {
      transaction.category = categoryId;
    }

    if (categoryId != null) {
      await assertReferenceOwner(account.budget_id, 'categories', categoryId);
    }
    if (transaction.schedule != null) {
      await assertReferenceOwner(
        account.budget_id,
        'schedules',
        transaction.schedule,
      );
    }
    if (transaction.transfer_id != null) {
      const paired =
        resulting.get(transaction.transfer_id) ??
        (await db.getTransaction(transaction.transfer_id));
      if (!paired) {
        throw new ValidationError(
          `Transfer transaction not found: ${transaction.transfer_id}`,
        );
      }
      const pairedOwner =
        ownerByAccount.get(paired.account) ??
        (await getBudgetIdForEntity({ table: 'accounts', id: paired.account }));
      if (pairedOwner !== account.budget_id) {
        throw new ValidationError(
          'Transfer transactions must belong to the same budget',
        );
      }
    }
    if (transaction.payee != null) {
      const payee = await db.first<Pick<db.DbPayee, 'transfer_acct'>>(
        'SELECT transfer_acct FROM payees WHERE id = ? AND tombstone = 0',
        [transaction.payee],
      );
      if (!payee && !pendingPayeeIds.has(transaction.payee)) {
        throw new ValidationError(
          `Transaction payee not found: ${transaction.payee}`,
        );
      }
      if (payee?.transfer_acct != null) {
        const transferOwner = await getBudgetIdForEntity({
          table: 'accounts',
          id: payee.transfer_acct,
        });
        if (transferOwner !== account.budget_id) {
          throw new ValidationError('Transfers cannot cross budget boundaries');
        }
      }
    }
  }

  // A split parent and every materialized child must belong to the same owner.
  for (const transaction of rows) {
    const owner = ownerByAccount.get(transaction.account)!;
    if (transaction.is_child && transaction.parent_id != null) {
      const parent =
        resulting.get(transaction.parent_id) ??
        (await db.getTransaction(transaction.parent_id));
      if (!parent) {
        throw new ValidationError(
          `Split parent not found: ${transaction.parent_id}`,
        );
      }
      const parentOwner =
        ownerByAccount.get(parent.account) ??
        (await getBudgetIdForEntity({ table: 'accounts', id: parent.account }));
      if (owner !== parentOwner) {
        throw new ValidationError(
          'Split transactions must belong to the same budget',
        );
      }
    }

    if (transaction.is_parent) {
      const children = await db.all<Pick<db.DbViewTransactionInternal, 'id'>>(
        'SELECT id FROM v_transactions_internal WHERE parent_id = ?',
        [transaction.id],
      );
      for (const childRow of children) {
        const child =
          resulting.get(childRow.id) ?? (await db.getTransaction(childRow.id));
        if (!child) continue;
        const childOwner =
          ownerByAccount.get(child.account) ??
          (await getBudgetIdForEntity({
            table: 'accounts',
            id: child.account,
          }));
        if (owner !== childOwner) {
          throw new ValidationError(
            'Split transactions must belong to the same budget',
          );
        }
        if (child.category != null) {
          await assertReferenceOwner(owner, 'categories', child.category);
        }
      }
    }
  }
  return rows.map(transaction => ({
    ...transaction,
    category: transaction.category ?? null,
  }));
}

async function assertReferenceOwner(
  budgetId: string,
  table: 'categories' | 'schedules',
  id: string,
): Promise<void> {
  const owner = await getBudgetIdForEntity({ table, id });
  if (owner !== budgetId) {
    throw new ValidationError(`${table} reference belongs to another budget`);
  }
}
