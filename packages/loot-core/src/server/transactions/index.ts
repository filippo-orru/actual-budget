// @ts-strict-ignore

import * as connection from '#platform/server/connection';
import {
  getCurrencyFeatureState,
  getEffectiveCurrency,
} from '#server/accounts/currency';
import * as db from '#server/db';
import { incrFetch, whereIn } from '#server/db/util';
import { batchMessages } from '#server/sync';
import type { Diff } from '#shared/util';
import type { PayeeEntity, TransactionEntity } from '#types/models';

import * as rules from './transaction-rules';
import * as transfer from './transfer';

async function idsWithChildren(ids: string[]) {
  const whereIds = whereIn(ids, 'parent_id');
  const rows = await db.all<Pick<db.DbViewTransactionInternal, 'id'>>(
    `SELECT id FROM v_transactions_internal WHERE ${whereIds}`,
  );
  const set = new Set(ids);
  for (const row of rows) {
    set.add(row.id);
  }
  return [...set];
}

async function getTransactionsByIds(
  ids: string[],
): Promise<TransactionEntity[]> {
  // TODO: convert to whereIn
  //
  // or better yet, use ActualQL
  return incrFetch(
    (query, params) => db.selectWithSchema('transactions', query, params),
    ids,

    id => `id = '${id}'`,
    where => `SELECT * FROM v_transactions_internal WHERE ${where}`,
  );
}

// Transfers are only allowed between accounts with the same effective
// currency. Runs before anything is written so a failure leaves no trace.
async function validateTransferCurrencies(
  added: Partial<TransactionEntity>[] | undefined,
  updated: Partial<TransactionEntity>[] | undefined,
) {
  if (!added?.length && !updated?.length) {
    return;
  }
  const { isCurrencyActive, globalCurrency } = await getCurrencyFeatureState();
  if (!isCurrencyActive) {
    return;
  }

  const existing = new Map<string, TransactionEntity>();
  if (updated?.length) {
    const rows = await getTransactionsByIds(updated.map(u => u.id));
    rows.forEach(row => existing.set(row.id, row));
  }

  const candidates: { account: string; payee: string }[] = [];
  for (const t of added ?? []) {
    if (t.account && t.payee) {
      candidates.push({ account: t.account, payee: t.payee });
    }
  }
  for (const t of updated ?? []) {
    const old = existing.get(t.id);
    if (!old) {
      continue;
    }
    const account = t.account ?? old.account;
    const payee = t.payee !== undefined ? t.payee : old.payee;
    // Only re-check when the account or the payee actually changes, so
    // legacy cross-currency transfers can still be edited.
    if (account === old.account && payee === old.payee) {
      continue;
    }
    if (account && payee) {
      candidates.push({ account, payee });
    }
  }
  if (candidates.length === 0) {
    return;
  }

  const payeeIds = [...new Set(candidates.map(c => c.payee))];
  const payees = await db.all<{ id: string; transfer_acct: string | null }>(
    `SELECT id, transfer_acct FROM v_payees WHERE ${whereIn(payeeIds, 'id')}`,
  );
  const transferAcctByPayee = new Map(
    payees.filter(p => p.transfer_acct).map(p => [p.id, p.transfer_acct]),
  );
  const transferring = candidates.filter(c => transferAcctByPayee.has(c.payee));
  if (transferring.length === 0) {
    return;
  }

  const accountRows = await db.all<Pick<db.DbAccount, 'id' | 'currency'>>(
    'SELECT id, currency FROM accounts',
  );
  const currencyById = new Map(
    accountRows.map(a => [a.id, getEffectiveCurrency(a, globalCurrency)]),
  );

  for (const { account, payee } of transferring) {
    const from = currencyById.get(account) ?? globalCurrency;
    const to =
      currencyById.get(transferAcctByPayee.get(payee)) ?? globalCurrency;
    if (from !== to) {
      throw new Error(
        `Transfers between accounts with different currencies (${from} → ${to}) are not supported.`,
      );
    }
  }
}

export async function batchUpdateTransactions({
  added,
  deleted,
  updated,
  learnCategories = false,
  detectOrphanPayees = true,
  runTransfers = true,
}: Partial<Diff<TransactionEntity>> & {
  learnCategories?: boolean;
  detectOrphanPayees?: boolean;
  runTransfers?: boolean;
}) {
  // Track the ids of each type of transaction change (see below for why)
  let addedIds = [];
  const updatedIds = updated ? updated.map(u => u.id) : [];
  const deletedIds = deleted
    ? await idsWithChildren(deleted.map(d => d.id))
    : [];

  if (runTransfers) {
    await validateTransferCurrencies(added, updated);
  }

  const oldPayees = new Set<PayeeEntity['id']>();

  // Accounts are only needed to clear the category of off-budget
  // transactions, so skip the read for edits that don't set an account
  const needsAccounts =
    (added?.length ?? 0) > 0 ||
    (updated?.some(transaction => transaction.account) ?? false);
  const accounts = needsAccounts
    ? await db.all<db.DbAccount>('SELECT * FROM accounts WHERE tombstone = 0')
    : [];

  // We need to get all the payees of updated transactions _before_
  // making changes
  if (updated) {
    const descUpdatedIds = updated
      .filter(update => update.payee)
      .map(update => update.id);

    const transactions = await getTransactionsByIds(descUpdatedIds);

    for (let i = 0; i < transactions.length; i++) {
      oldPayees.add(transactions[i].payee);
    }
  }

  // Apply all the updates. We can batch this now! This is important
  // and makes bulk updates much faster
  await batchMessages(async () => {
    if (added) {
      addedIds = await Promise.all(
        added.map(async t => {
          // Offbudget account transactions and parent transactions should not have categories.
          const account = accounts.find(acct => acct.id === t.account);
          if (t.is_parent || account?.offbudget === 1) {
            t.category = null;
          }
          return db.insertTransaction(t);
        }),
      );
    }

    if (deleted) {
      await Promise.all(
        // It's important to use `deletedIds` and not `deleted` here
        // because we've expanded it to include children above. The
        // inconsistency of the delete APIs is annoying and should
        // be fixed (it should only take an id)
        deletedIds.map(async id => {
          await db.deleteTransaction({ id });
        }),
      );
    }

    if (updated) {
      await Promise.all(
        updated.map(async t => {
          if (t.account) {
            // Moving transactions off budget should always clear the
            // category. Parent transactions should not have categories.
            const account = accounts.find(acct => acct.id === t.account);
            if (t.is_parent || account?.offbudget === 1) {
              t.category = null;
            }
          }

          await db.updateTransaction(t);
        }),
      );
    }
  });

  // Get all of the full transactions that were changed. This is
  // needed to run any cascading logic that depends on the full
  // transaction. Things like transfers, analyzing rule updates, and
  // more
  //
  // One read for all of them: on the web backend every query is a
  // separate lock/commit cycle against IndexedDB
  const changedTransactions = await getTransactionsByIds([
    ...new Set([...addedIds, ...updatedIds, ...deletedIds]),
  ]);
  const changedById = new Map(
    changedTransactions.map(transaction => [transaction.id, transaction]),
  );
  const pickTransactions = (ids: string[]) =>
    [...new Set(ids)]
      .map(id => changedById.get(id))
      .filter((transaction): transaction is TransactionEntity =>
        Boolean(transaction),
      );
  const allAdded = pickTransactions(addedIds);
  const allUpdated = pickTransactions(updatedIds);
  const allDeleted = pickTransactions(deletedIds);

  // Post-processing phase: first do any updates to transfers.
  // Transfers update the transactions and we need to return updates
  // to the client so that can apply them. Note that added
  // transactions just return the full transaction.
  const resultAdded = allAdded;
  const resultUpdated = allUpdated;
  let transfersUpdated: Awaited<ReturnType<typeof transfer.onUpdate>>[];

  if (runTransfers) {
    await batchMessages(async () => {
      await Promise.all(allAdded.map(t => transfer.onInsert(t)));

      // Return any updates from here
      transfersUpdated = (
        await Promise.all(allUpdated.map(t => transfer.onUpdate(t)))
      ).filter(Boolean);

      await Promise.all(allDeleted.map(t => transfer.onDelete(t)));
    });
  }

  if (learnCategories) {
    // Analyze any updated categories and update rules to learn from
    // the user's activity
    const ids = new Set([
      ...(added ? added.filter(add => add.category).map(add => add.id) : []),
      ...(updated
        ? updated.filter(update => update.category).map(update => update.id)
        : []),
    ]);
    await rules.updateCategoryRules(
      allAdded.concat(allUpdated).filter(trans => ids.has(trans.id)),
    );
  }

  if (detectOrphanPayees) {
    // Look for any orphaned payees and notify the user about merging
    // them

    if (updated) {
      const newPayeeIds = updated.map(u => u.payee).filter(Boolean);
      if (newPayeeIds.length > 0) {
        const allOrphaned = new Set(await db.getOrphanedPayees());

        const orphanedIds = [...oldPayees].filter(id => allOrphaned.has(id));

        if (orphanedIds.length > 0) {
          connection.send('orphaned-payees', {
            orphanedIds,
            updatedPayeeIds: newPayeeIds,
          });
        }
      }
    }
  }

  return {
    added: resultAdded,
    updated: runTransfers ? transfersUpdated : resultUpdated,
    deleted: allDeleted,
    errors: ((added || []) as Partial<TransactionEntity>[])
      .concat(updated || [])
      .flatMap(t => t._ruleErrors || []),
  };
}
