import { q } from '@actual-app/core/shared/query';

import {
  foreignAccountFilter,
  getForeignAccounts,
  withoutForeignAccounts,
} from './foreignAccountFilter';

describe('foreignAccountFilter', () => {
  it('keeps accounts without a currency and with the global currency', () => {
    expect(foreignAccountFilter('USD')).toEqual({
      $or: [{ 'account.currency': null }, { 'account.currency': 'USD' }],
    });
  });

  it('is null (nothing excluded) without a global currency', () => {
    expect(foreignAccountFilter(undefined)).toBeNull();
    expect(foreignAccountFilter('')).toBeNull();
  });

  it('adds the filter to a query only when multi-currency is on', () => {
    const base = q('transactions');

    expect(withoutForeignAccounts(base, undefined)).toBe(base);
    expect(
      withoutForeignAccounts(base, 'USD').serialize().filterExpressions,
    ).toEqual([foreignAccountFilter('USD')]);
  });
});

describe('getForeignAccounts', () => {
  const accounts = [
    { id: 'a', name: 'Checking', currency: null, tombstone: 0 as const },
    { id: 'b', name: 'Labelled', currency: 'USD', tombstone: 0 as const },
    { id: 'c', name: 'Euro', currency: 'EUR', tombstone: 0 as const },
    { id: 'd', name: 'Deleted yen', currency: 'JPY', tombstone: 1 as const },
  ];

  it('lists the accounts in another currency', () => {
    expect(getForeignAccounts(accounts, 'USD').map(a => a.id)).toEqual(['c']);
  });

  it('lists nothing without a global currency', () => {
    expect(getForeignAccounts(accounts, undefined)).toEqual([]);
  });
});
