import { describe, expect, it } from 'vitest';

import { makeQuery } from './makeQuery';

describe('makeQuery', () => {
  it('keeps the budget owner filter separate from user OR conditions', () => {
    const query = makeQuery(
      'budget-a',
      'assets',
      '2025-01',
      '2025-02',
      'Monthly',
      '$or',
      [{ 'account.budget_id': 'budget-b' }, { category: 'foreign-category' }],
    );

    expect(query.serialize().filterExpressions.slice(0, 2)).toEqual([
      { 'account.budget_id': 'budget-a' },
      {
        $or: [
          { 'account.budget_id': 'budget-b' },
          { category: 'foreign-category' },
        ],
      },
    ]);
  });
});
