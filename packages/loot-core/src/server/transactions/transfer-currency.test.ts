import * as db from '#server/db';

import { batchUpdateTransactions } from './index';

beforeEach(global.emptyDatabase());

function setPref(id: string, value: string) {
  db.runQuery('INSERT OR REPLACE INTO preferences (id, value) VALUES (?, ?)', [
    id,
    value,
  ]);
}

async function setup({ active = true } = {}) {
  if (active) {
    setPref('flags.currency', 'true');
    setPref('defaultCurrencyCode', 'USD');
  }
  await db.insertAccount({ id: 'usd', name: 'usd', offbudget: 0 });
  await db.insertAccount({
    id: 'usd2',
    name: 'usd2',
    offbudget: 1,
    currency: 'USD',
  });
  await db.insertAccount({
    id: 'eur',
    name: 'eur',
    offbudget: 1,
    currency: 'EUR',
  });
  await db.insertAccount({
    id: 'eur2',
    name: 'eur2',
    offbudget: 1,
    currency: 'EUR',
  });
  for (const id of ['usd', 'usd2', 'eur', 'eur2']) {
    await db.insertPayee({ id: `p-${id}`, name: '', transfer_acct: id });
  }
}

async function count() {
  const row = await db.first<{ c: number }>(
    'SELECT COUNT(*) AS c FROM v_transactions_internal WHERE tombstone = 0',
  );
  return row?.c;
}

const base = { amount: -500, date: '2026-01-01' };

describe('transfer currency guard', () => {
  it('blocks inserting a cross-currency transfer and writes nothing', async () => {
    await setup();
    await expect(
      batchUpdateTransactions({
        added: [{ id: 't1', account: 'eur', payee: 'p-usd2', ...base }],
      }),
    ).rejects.toThrow(/EUR → USD/);
    expect(await count()).toBe(0);
  });

  it('blocks split children that transfer across currencies', async () => {
    await setup();
    await expect(
      batchUpdateTransactions({
        added: [
          { id: 'parent', account: 'eur', is_parent: true, ...base },
          {
            id: 'child',
            account: 'eur',
            is_child: true,
            parent_id: 'parent',
            payee: 'p-usd2',
            ...base,
          },
        ],
      }),
    ).rejects.toThrow(/not supported/);
    expect(await count()).toBe(0);
  });

  it('blocks changing the payee to a cross-currency transfer payee', async () => {
    await setup();
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'eur', ...base }],
    });
    await expect(
      batchUpdateTransactions({ updated: [{ id: 't1', payee: 'p-usd2' }] }),
    ).rejects.toThrow(/not supported/);
    const t = await db.first<{ payee: string | null }>(
      'SELECT payee FROM v_transactions_internal WHERE id = ?',
      ['t1'],
    );
    expect(t?.payee).toBeNull();
  });

  it('blocks moving a transfer to an account with another currency', async () => {
    await setup();
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'eur', payee: 'p-eur2', ...base }],
    });
    await expect(
      batchUpdateTransactions({ updated: [{ id: 't1', account: 'usd2' }] }),
    ).rejects.toThrow(/not supported/);
    const t = await db.first<{ account: string }>(
      'SELECT account FROM v_transactions_internal WHERE id = ?',
      ['t1'],
    );
    expect(t?.account).toBe('eur');
  });

  it('allows same-currency transfers', async () => {
    await setup();
    await batchUpdateTransactions({
      added: [
        { id: 't1', account: 'eur', payee: 'p-eur2', ...base },
        { id: 't2', account: 'usd', payee: 'p-usd2', ...base },
      ],
    });
    // two transactions plus their counterparts
    expect(await count()).toBe(4);
  });

  it('does nothing when the currency feature is inactive', async () => {
    await setup({ active: false });
    await batchUpdateTransactions({
      added: [{ id: 't1', account: 'eur', payee: 'p-usd2', ...base }],
    });
    expect(await count()).toBe(2);
  });
});
