import { describe, expect, it } from 'vitest';

import type { TransactionEntity } from '#types/models';

import { transformAccountTransactions } from './transform';

function transaction(
  id: string,
  amount: number,
  options: Partial<TransactionEntity> = {},
): TransactionEntity {
  return {
    id,
    account: 'source',
    amount,
    date: '2024-01-02',
    ...options,
  };
}

describe('transformAccountTransactions', () => {
  it('converts amounts on transaction dates, excludes reconciliation adjustments, and reconciles the requested balance', () => {
    const result = transformAccountTransactions(
      [
        transaction('income', 10000),
        transaction('expense', -5000, { date: '2024-02-02', reconciled: true }),
        transaction('adjustment', 900, {
          notes: 'Imported: Reconciliation balance adjustment from old account',
        }),
      ],
      {
        sourceAccountId: 'source',
        destinationAccountId: 'destination',
        inputCurrency: 'USD',
        destinationCurrency: 'EUR',
        rates: { '2024-01-02': 0.9, '2024-02-02': 0.8 },
        idForSource: id => `new-${id}`,
        adjustmentId: 'balance-adjustment',
        migrationDate: '2024-03-01',
        targetBalance: 5500,
      },
    );

    expect(result.transactions.map(row => row.amount)).toEqual([
      9000, -4000, 500,
    ]);
    expect(result.convertedTotal).toBe(5000);
    expect(result.adjustment).toBe(500);
    expect(result.excluded.map(row => row.id)).toEqual(['adjustment']);
    expect(result.transactions[1].reconciled).toBe(false);
  });

  it('retains split children and distributes conversion rounding to match the parent', () => {
    const parent = transaction('parent', 3, {
      is_parent: true,
      subtransactions: undefined,
    });
    const children = [
      transaction('child-b', 1, { is_child: true, parent_id: 'parent' }),
      transaction('child-a', 1, {
        is_child: true,
        parent_id: 'parent',
        notes: 'Reconciliation balance adjustment',
      }),
      transaction('child-c', 2, { is_child: true, parent_id: 'parent' }),
    ];
    const result = transformAccountTransactions(
      [{ ...parent, subtransactions: children }],
      {
        sourceAccountId: 'source',
        destinationAccountId: 'destination',
        inputCurrency: 'USD',
        destinationCurrency: 'EUR',
        rates: { '2024-01-02': 1.5 },
        idForSource: id => `new-${id}`,
        adjustmentId: 'adjustment',
        migrationDate: '2024-03-01',
      },
    );

    expect(result.transactions[0].amount).toBe(5);
    expect(result.transactions.slice(1).map(row => row.amount)).toEqual([2, 3]);
    expect(
      result.transactions.slice(1).reduce((sum, row) => sum + row.amount, 0),
    ).toBe(result.transactions[0].amount);
    expect(result.partialSplitExclusions).toEqual([
      { id: 'parent', excludedChildIds: ['child-a'] },
    ]);
  });

  it('does not request or apply an FX rate for an identity conversion', () => {
    const result = transformAccountTransactions([transaction('t', -37)], {
      sourceAccountId: 'source',
      destinationAccountId: 'destination',
      inputCurrency: 'USD',
      destinationCurrency: 'USD',
      rates: {},
      idForSource: id => `new-${id}`,
      adjustmentId: 'adjustment',
      migrationDate: '2024-03-01',
    });

    expect(result.transactions[0].amount).toBe(-37);
  });
});
