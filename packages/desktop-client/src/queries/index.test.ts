import { describe, expect, it } from 'vitest';

import {
  accountFilter,
  transactions,
  uncategorizedTransactions,
} from './index';

describe('budget-scoped transaction queries', () => {
  it('always filters transaction queries by the owning budget', () => {
    expect(transactions('budget-a').state.filterExpressions).toContainEqual({
      'account.budget_id': 'budget-a',
    });
    expect(
      transactions('budget-a', 'onbudget').state.filterExpressions,
    ).toContainEqual({
      $and: [
        { 'account.budget_id': 'budget-a' },
        { 'account.offbudget': false },
        { 'account.closed': false },
      ],
    });
  });

  it('ANDs the owner filter with caller-supplied account conditions', () => {
    expect(accountFilter('budget-a', 'account-1')).toEqual({
      $and: [{ 'account.budget_id': 'budget-a' }, { account: 'account-1' }],
    });
  });

  it('scopes uncategorized transactions to the owning budget', () => {
    expect(
      uncategorizedTransactions('budget-a').state.filterExpressions,
    ).toContainEqual(
      expect.objectContaining({ 'account.budget_id': 'budget-a' }),
    );
  });
});
