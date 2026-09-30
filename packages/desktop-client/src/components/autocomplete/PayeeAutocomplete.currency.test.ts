import { filterCurrencyIncompatibleTransferPayees } from './PayeeAutocomplete';

const accounts = [
  { id: 'eur1', currency: 'EUR' },
  { id: 'eur2', currency: 'EUR' },
  { id: 'usd-offbudget', currency: 'USD' },
  { id: 'onbudget', currency: null },
];

const payees = [
  { id: 'p0', transfer_acct: undefined },
  { id: 'p-eur2', transfer_acct: 'eur2' },
  { id: 'p-usd', transfer_acct: 'usd-offbudget' },
  { id: 'p-on', transfer_acct: 'onbudget' },
];

function idsFor(currentAccountId: string | undefined, globalCurrency = 'USD') {
  return filterCurrencyIncompatibleTransferPayees(
    payees,
    accounts,
    currentAccountId,
    globalCurrency,
  ).map(p => p.id);
}

describe('filterCurrencyIncompatibleTransferPayees', () => {
  it('in a EUR account hides USD transfer payees but keeps EUR ones', () => {
    expect(idsFor('eur1')).toEqual(['p0', 'p-eur2']);
  });

  it('treats NULL currency as the global currency', () => {
    expect(idsFor('onbudget')).toEqual(['p0', 'p-usd', 'p-on']);
    expect(idsFor('onbudget', 'EUR')).toEqual(['p0', 'p-eur2', 'p-on']);
  });

  it('does not filter without a known current account', () => {
    expect(idsFor(undefined)).toHaveLength(payees.length);
    expect(idsFor('unknown')).toHaveLength(payees.length);
  });
});
