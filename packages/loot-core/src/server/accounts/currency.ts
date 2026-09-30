import * as db from '#server/db';
import { currencies } from '#shared/currencies';

export type CurrencyFeatureState = {
  isCurrencyActive: boolean;
  isMultiCurrencyEnabled: boolean;
  globalCurrency: string;
};

export type CrossCurrencyTransfer = {
  transactionId: string;
  date: string;
  accountId: string;
  accountName: string;
  otherAccountId: string;
  otherAccountName: string;
};

export async function getCurrencyFeatureState(): Promise<CurrencyFeatureState> {
  const rows = await db.all<{ id: string; value: string | null }>(
    `SELECT id, value FROM preferences
       WHERE id IN ('flags.currency', 'flags.multiCurrency', 'defaultCurrencyCode')`,
  );
  const prefs = new Map(rows.map(row => [row.id, row.value ?? '']));
  const globalCurrency = prefs.get('defaultCurrencyCode') ?? '';
  return {
    isCurrencyActive:
      prefs.get('flags.currency') === 'true' && globalCurrency !== '',
    isMultiCurrencyEnabled: prefs.get('flags.multiCurrency') === 'true',
    globalCurrency,
  };
}

export function getEffectiveCurrency(
  account: { currency?: string | null },
  globalCurrency: string,
): string {
  return account.currency ?? globalCurrency;
}

/**
 * Returns the transfers between accounts whose effective currencies differ.
 * Each transfer pair is listed once. Optionally restricted to one account, and
 * optionally pretending that an account has a different currency.
 */
export async function getCrossCurrencyTransfers({
  globalCurrency,
  accountId = null,
  assumeCurrency = null,
}: {
  globalCurrency: string;
  accountId?: string | null;
  assumeCurrency?: { accountId: string; currency: string } | null;
}): Promise<CrossCurrencyTransfer[]> {
  const effective = (alias: string) =>
    `COALESCE(CASE WHEN ${alias}.id = ? THEN ? ELSE ${alias}.currency END, ?)`;
  const assumedId = assumeCurrency?.accountId ?? null;
  const assumed = assumeCurrency?.currency ?? null;

  return db.all<CrossCurrencyTransfer>(
    `SELECT t.id AS transactionId, t.date AS date,
            a.id AS accountId, a.name AS accountName,
            b.id AS otherAccountId, b.name AS otherAccountName
       FROM v_transactions_internal t
       JOIN v_payees p ON p.id = t.payee
       JOIN accounts a ON a.id = t.account AND a.tombstone = 0
       JOIN accounts b ON b.id = p.transfer_acct AND b.tombstone = 0
      WHERE t.tombstone = 0
        AND p.transfer_acct IS NOT NULL
        AND a.id < b.id
        AND ${effective('a')} != ${effective('b')}
        ${accountId ? 'AND (a.id = ? OR b.id = ?)' : ''}
      ORDER BY t.date, t.id`,
    [
      assumedId,
      assumed,
      globalCurrency,
      assumedId,
      assumed,
      globalCurrency,
      ...(accountId ? [accountId, accountId] : []),
    ],
  );
}

export async function validateAccountCurrency({
  account,
  currency,
  isNewAccount = false,
}: {
  account: {
    id?: string;
    offbudget?: 0 | 1 | boolean;
    currency?: string | null;
  };
  currency: string;
  isNewAccount?: boolean;
}): Promise<void> {
  const { isCurrencyActive, globalCurrency } = await getCurrencyFeatureState();

  if (!isCurrencyActive) {
    throw new Error(
      'Account currencies require the currency feature and a default currency to be set.',
    );
  }
  if (!currency || !currencies.some(c => c.code === currency)) {
    throw new Error(`Unknown currency code: '${currency}'`);
  }
  if (!account.offbudget) {
    throw new Error('Only off-budget accounts can have a currency.');
  }
  if (isNewAccount) {
    return;
  }
  if (account.currency != null) {
    throw new Error('The currency of this account cannot be changed.');
  }
  if (!account.id) {
    throw new Error('Account id is required.');
  }
  const conflicts = await getCrossCurrencyTransfers({
    globalCurrency,
    accountId: account.id,
    assumeCurrency: { accountId: account.id, currency },
  });
  if (conflicts.length > 0) {
    throw new Error(
      `This account has transfers with accounts in a different currency (${currency}).`,
    );
  }
}
