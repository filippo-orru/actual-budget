import { logger } from '#platform/server/log';
import * as db from '#server/db';
import { addSyncListener } from '#server/sync';

type InvalidReference = {
  id: string;
  account_budget_id: string | null;
  category_budget_id: string | null;
  schedule_budget_id: string | null;
  transfer_budget_id: string | null;
  parent_budget_id: string | null;
};

const reportedTransactionIds = new Set<string>();

export async function reportInvalidTransactionReferences(ids: string[]) {
  if (ids.length === 0) {
    return;
  }

  const placeholders = ids.map(() => '?').join(', ');
  const invalid = await db.all<InvalidReference>(
    `SELECT t.id,
            a.budget_id AS account_budget_id,
            c.budget_id AS category_budget_id,
            s.budget_id AS schedule_budget_id,
            ta.budget_id AS transfer_budget_id,
            pa.budget_id AS parent_budget_id
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.acct
       LEFT JOIN transactions pt ON pt.id = t.parent_id
       LEFT JOIN accounts pa ON pa.id = pt.acct
       LEFT JOIN categories c ON c.id = t.category
       LEFT JOIN schedules s ON s.id = t.schedule
       LEFT JOIN v_transactions v ON v.id = t.id
       LEFT JOIN payees p ON p.id = v.payee
       LEFT JOIN accounts ta ON ta.id = p.transfer_acct
      WHERE t.id IN (${placeholders})
        AND (a.budget_id IS NULL
          OR (c.budget_id IS NOT NULL AND c.budget_id != a.budget_id)
          OR (s.budget_id IS NOT NULL AND s.budget_id != a.budget_id)
          OR (ta.budget_id IS NOT NULL AND ta.budget_id != a.budget_id)
          OR (pa.budget_id IS NOT NULL AND pa.budget_id != a.budget_id))`,
    ids,
  );

  const newlyReported = invalid
    .map(row => row.id)
    .filter(id => !reportedTransactionIds.has(id));
  if (newlyReported.length > 0) {
    newlyReported.forEach(id => reportedTransactionIds.add(id));
    logger.warn(
      'Incoming sync contains cross-budget transaction references; synced history was not modified.',
      { transactionIds: newlyReported },
    );
  }
}

async function getAffectedTransactionIds(
  table: 'accounts' | 'categories' | 'schedules' | 'payees',
  ids: string[],
) {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => '?').join(', ');
  const queryByTable = {
    accounts: `SELECT id FROM transactions WHERE acct IN (${placeholders})`,
    categories: `SELECT id FROM transactions WHERE category IN (${placeholders})`,
    schedules: `SELECT id FROM transactions WHERE schedule IN (${placeholders})`,
    payees: `SELECT t.id FROM transactions t
             JOIN v_transactions v ON v.id = t.id
             WHERE v.payee IN (${placeholders})`,
  };
  const rows = await db.all<{ id: string }>(queryByTable[table], ids);
  return rows.map(row => row.id);
}

export function startBudgetIntegrityMonitor() {
  return addSyncListener((_oldValues, newValues) => {
    const idsToCheck = new Set<string>();
    const transactions = newValues.get('transactions') as
      | Array<{ id: string }>
      | undefined;
    transactions?.forEach(transaction => idsToCheck.add(transaction.id));

    const referenceTables = [
      'accounts',
      'categories',
      'schedules',
      'payees',
      'payee_mapping',
    ] as const;
    for (const table of referenceTables) {
      const changes = newValues.get(table) as
        | Array<{ id: string; targetId?: string }>
        | undefined;
      if (!changes?.length) {
        continue;
      }
      const ids = changes.flatMap(change =>
        table === 'payee_mapping'
          ? [change.id, ...(change.targetId ? [change.targetId] : [])]
          : [change.id],
      );
      const queryTable = table === 'payee_mapping' ? 'payees' : table;
      void getAffectedTransactionIds(queryTable, ids)
        .then(affectedIds => {
          affectedIds.forEach(id => idsToCheck.add(id));
          return reportInvalidTransactionReferences([...idsToCheck]);
        })
        .catch(error => {
          logger.error(
            'Failed checking synced budget ownership integrity',
            error,
          );
        });
    }

    if (
      transactions?.length &&
      referenceTables.every(table => !newValues.get(table))
    ) {
      void reportInvalidTransactionReferences([...idsToCheck]).catch(error => {
        logger.error(
          'Failed checking synced budget ownership integrity',
          error,
        );
      });
    }
  });
}
