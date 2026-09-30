import type { Query } from '@actual-app/core/shared/query';
import type { AccountEntity } from '@actual-app/core/types/models';

/**
 * AQL filter that excludes the transactions of foreign-currency accounts,
 * i.e. keeps accounts without a currency (global currency) or whose currency
 * is the global one. Returns null when `globalCurrency` is not set, which
 * means multi-currency is off and nothing is excluded.
 */
export function foreignAccountFilter(globalCurrency?: string | null) {
  if (!globalCurrency) {
    return null;
  }
  return {
    $or: [{ 'account.currency': null }, { 'account.currency': globalCurrency }],
  };
}

/** Applies `foreignAccountFilter` to a transactions query. */
export function withoutForeignAccounts(
  query: Query,
  globalCurrency?: string | null,
): Query {
  const filter = foreignAccountFilter(globalCurrency);
  return filter ? query.filter(filter) : query;
}

/** The accounts the filter excludes. */
export function getForeignAccounts(
  accounts: Pick<AccountEntity, 'id' | 'name' | 'currency' | 'tombstone'>[],
  globalCurrency?: string | null,
) {
  if (!globalCurrency) {
    return [];
  }
  return accounts.filter(
    account =>
      !account.tombstone &&
      account.currency != null &&
      account.currency !== globalCurrency,
  );
}
