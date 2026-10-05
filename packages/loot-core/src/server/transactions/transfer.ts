// @ts-strict-ignore
import { v4 as uuidv4 } from 'uuid';

import * as db from '#server/db';

import { runRules } from './transaction-rules';
import { validateTransactionWrites } from './validate';

async function getPayee(acct) {
  return db.first<db.DbPayee>('SELECT * FROM payees WHERE transfer_acct = ?', [
    acct,
  ]);
}

async function getTransferredAccount(transaction) {
  if (transaction.payee) {
    const result = await db.first<Pick<db.DbViewPayee, 'transfer_acct'>>(
      'SELECT transfer_acct FROM v_payees WHERE id = ?',
      [transaction.payee],
    );

    return result?.transfer_acct || null;
  }
  return null;
}

async function clearCategory(transaction, transferAcct) {
  const { offbudget: fromOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transaction.account]);
  const { offbudget: toOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transferAcct]);

  // If the transfer is between two on budget or two off budget accounts,
  // we should clear the category, because the category is not relevant
  if (fromOffBudget === toOffBudget) {
    await db.updateTransaction({ id: transaction.id, category: null });
    if (transaction.transfer_id) {
      await db.updateTransaction({
        id: transaction.transfer_id,
        category: null,
      });
    }
    return true;
  }
  return false;
}

export type PreparedTransfer = {
  notes: string | null;
  cleared: boolean;
  schedule: string | null;
};

export async function validateTransferInserts(
  transactions,
  pendingPayees: Map<string, { id: string; name: string }>,
): Promise<Map<string, PreparedTransfer>> {
  const preparedTransfers = new Map<string, PreparedTransfer>();
  for (const transaction of transactions) {
    if (transaction.is_parent) continue;
    const transferredAccount = await getTransferredAccount(transaction);
    if (!transferredAccount) continue;

    const fromPayee = await db.first<Pick<db.DbPayee, 'id'>>(
      'SELECT id FROM payees WHERE transfer_acct = ?',
      [transaction.account],
    );
    if (!fromPayee) throw new Error('Transfer source payee not found');

    if (transaction.transfer_id) {
      const counterpart = await db.getTransaction(transaction.transfer_id);
      if (!counterpart) {
        throw new Error(
          `Transfer transaction not found: ${transaction.transfer_id}`,
        );
      }
      await validateTransactionWrites({
        updated: [
          {
            id: counterpart.id,
            account: transferredAccount,
            amount: -transaction.amount,
            payee: fromPayee.id,
            notes: transaction.notes || null,
            schedule: transaction.schedule,
          },
        ],
      });
      continue;
    }
    const transferTransaction = {
      id: uuidv4(),
      account: transferredAccount,
      amount: -transaction.amount,
      payee: fromPayee.id,
      date: transaction.date,
      notes: transaction.notes || null,
      schedule: transaction.schedule,
      cleared: false,
    };
    const { notes, cleared, schedule } = await runRules(
      transferTransaction,
      null,
      pendingPayees,
    );
    const matchedSchedule = schedule ?? transaction.schedule;
    await validateTransactionWrites({
      added: [
        {
          ...transferTransaction,
          notes,
          cleared,
          schedule: matchedSchedule,
        },
      ],
      pendingPayeeIds: new Set(pendingPayees.keys()),
    });
    preparedTransfers.set(transaction.id, {
      notes,
      cleared,
      schedule: matchedSchedule,
    });
  }
  return preparedTransfers;
}

export async function addTransfer(
  transaction,
  transferredAccount,
  prepared?: PreparedTransfer,
) {
  if (transaction.is_parent) {
    // For split transactions, we should create transfers using child transactions.
    // This is to ensure that the amounts received by the transferred account
    // reflects the amounts in the child transactions and not the parent transaction
    // amount which is the total amount.
    return null;
  }

  const { id: fromPayee } = await db.first<Pick<db.DbPayee, 'id'>>(
    'SELECT id FROM payees WHERE transfer_acct = ?',
    [transaction.account],
  );

  const transferTransaction = {
    id: uuidv4(),
    account: transferredAccount,
    amount: -transaction.amount,
    payee: fromPayee,
    date: transaction.date,
    transfer_id: transaction.id,
    notes: transaction.notes || null,
    schedule: transaction.schedule,
    cleared: false,
  };
  const pendingPayees = new Map<string, { id: string; name: string }>();
  const { notes, cleared, schedule } =
    prepared ?? (await runRules(transferTransaction, null, pendingPayees));
  const matchedSchedule =
    prepared?.schedule ?? schedule ?? transaction.schedule;
  const validatedTransfer = {
    ...transferTransaction,
    notes,
    cleared,
    schedule: matchedSchedule,
  };
  await validateTransactionWrites({
    added: [validatedTransfer],
    pendingPayeeIds: new Set(pendingPayees.keys()),
  });
  for (const payee of pendingPayees.values()) {
    await db.insertPayee(payee);
  }

  const id = await db.insertTransaction({
    ...validatedTransfer,
    notes,
    cleared,
    schedule: matchedSchedule,
  });

  await db.updateTransaction({
    id: transaction.id,
    transfer_id: id,
    ...(matchedSchedule ? { schedule: matchedSchedule } : {}),
  });
  const categoryCleared = await clearCategory(transaction, transferredAccount);

  return {
    id: transaction.id,
    transfer_id: id,
    ...(categoryCleared ? { category: null } : {}),
  };
}

export async function removeTransfer(transaction) {
  const transferTrans = await db.getTransaction(transaction.transfer_id);

  // Perform operations on the transfer transaction only
  // if it is found. For example: when users delete both
  // (in & out) transfer transactions at the same time -
  // transfer transaction will not be found.
  if (transferTrans) {
    if (transferTrans.is_child) {
      // If it's a child transaction, we don't delete it because that
      // would invalidate the whole split transaction. Instead of turn
      // it into a normal transaction
      await db.updateTransaction({
        id: transaction.transfer_id,
        transfer_id: null,
        payee: null,
      });
    } else {
      await db.deleteTransaction({ id: transaction.transfer_id });
    }
  }
  await db.updateTransaction({ id: transaction.id, transfer_id: null });
  return { id: transaction.id, transfer_id: null };
}

export async function updateTransfer(transaction, transferredAccount) {
  const payee = await getPayee(transaction.account);

  await validateTransactionWrites({
    updated: [
      {
        id: transaction.transfer_id,
        account: transferredAccount,
        payee: payee.id,
        notes: transaction.notes,
        amount: -transaction.amount,
        schedule: transaction.schedule,
      },
    ],
  });
  await db.updateTransaction({
    id: transaction.transfer_id,
    account: transferredAccount,
    // Make sure to update the payee on the other side in case the
    // user moved this transaction into another account
    payee: payee.id,
    notes: transaction.notes,
    amount: -transaction.amount,
    schedule: transaction.schedule,
  });

  const categoryCleared = await clearCategory(transaction, transferredAccount);
  if (categoryCleared) {
    return { id: transaction.id, category: null };
  }
}

export async function onInsert(transaction, preparedTransfers?) {
  const transferredAccount = await getTransferredAccount(transaction);

  if (transferredAccount) {
    return addTransfer(
      transaction,
      transferredAccount,
      preparedTransfers?.get(transaction.id),
    );
  }
}

export async function onDelete(transaction) {
  if (transaction.transfer_id) {
    await removeTransfer(transaction);
  }
}

export async function onUpdate(transaction, preparedTransfers?) {
  const transferredAccount = await getTransferredAccount(transaction);

  if (transaction.is_parent) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && !transaction.transfer_id) {
    return addTransfer(
      transaction,
      transferredAccount,
      preparedTransfers?.get(transaction.id),
    );
  }

  if (!transferredAccount && transaction.transfer_id) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && transaction.transfer_id) {
    return updateTransfer(transaction, transferredAccount);
  }
}
