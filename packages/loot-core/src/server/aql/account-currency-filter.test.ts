import * as db from '#server/db';
import { q } from '#shared/query';

import * as aql from './exec';
import { schema, schemaConfig } from './schema';

beforeEach(global.emptyDatabase());

// Mirrors the filter the multi-currency report exclusion guard uses
// (desktop-client `foreignAccountFilter`): null or the global currency.
const excludeForeignAccounts = (globalCurrency: string) => ({
  $or: [{ 'account.currency': null }, { 'account.currency': globalCurrency }],
});

async function sumByAccount(
  query: ReturnType<typeof q>,
): Promise<Record<string, number>> {
  const { data } = await aql.compileAndRunAqlQuery(
    schema,
    schemaConfig,
    query
      .groupBy('account')
      .select(['account', { amount: { $sum: '$amount' } }])
      .serialize(),
    {},
  );
  return Object.fromEntries(
    (data as Array<{ account: string; amount: number }>).map(row => [
      row.account,
      row.amount,
    ]),
  );
}

describe('AQL account currency filters', () => {
  beforeEach(async () => {
    await db.insertAccount({ id: 'usd', name: 'USD checking' });
    await db.insertAccount({
      id: 'usd-labelled',
      name: 'USD labelled',
      offbudget: 1,
      currency: 'USD',
    });
    await db.insertAccount({
      id: 'eur',
      name: 'EUR savings',
      offbudget: 1,
      currency: 'EUR',
    });
    for (const [account, amount] of [
      ['usd', 1000],
      ['usd-labelled', 2000],
      ['eur', 4000],
    ] as const) {
      await db.insertTransaction({
        id: `tx-${account}`,
        account,
        amount,
        date: '2026-01-01',
      });
    }
  });

  it('keeps accounts without a currency and with the global currency', async () => {
    const sums = await sumByAccount(
      q('transactions').filter(excludeForeignAccounts('USD')),
    );

    expect(sums).toEqual({ usd: 1000, 'usd-labelled': 2000 });
  });

  it('matches null account currencies with an equality filter', async () => {
    const sums = await sumByAccount(
      q('transactions').filter({ 'account.currency': null }),
    );

    expect(sums).toEqual({ usd: 1000 });
  });

  it('sums the native amounts per account', async () => {
    const sums = await sumByAccount(q('transactions'));

    expect(sums).toEqual({ usd: 1000, 'usd-labelled': 2000, eur: 4000 });
  });
});
