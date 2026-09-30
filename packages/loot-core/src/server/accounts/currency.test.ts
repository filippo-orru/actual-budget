import { installAPI } from '#server/api';
import * as db from '#server/db';
import * as prefs from '#server/prefs';
import type { ServerHandlers } from '#types/server-handlers';

import { app as accountsApp } from './app';
import { getCrossCurrencyTransfers } from './currency';

const handlers = accountsApp.handlers;

function setPref(id: string, value: string): Promise<void> {
  db.runQuery('INSERT OR REPLACE INTO preferences (id, value) VALUES (?, ?)', [
    id,
    value,
  ]);
  return Promise.resolve();
}

async function enableCurrency(global = 'USD') {
  await setPref('flags.currency', 'true');
  await setPref('defaultCurrencyCode', global);
}

async function createTransfer(from: string, to: string) {
  const payee = await db.first<{ id: string }>(
    'SELECT id FROM payees WHERE transfer_acct = ?',
    [to],
  );
  return db.insertTransaction({
    account: from,
    amount: -100,
    payee: payee!.id,
    date: '2026-01-01',
  });
}

describe('account currency', () => {
  beforeEach(global.emptyDatabase());
  beforeEach(async () => {
    await prefs.loadPrefs();
  });

  async function currencyOf(id: string) {
    const rows = await handlers['accounts-get']();
    return rows.find(a => a.id === id)?.currency;
  }

  describe('account-set-currency', () => {
    it('sets the currency of an off-budget account and persists it', async () => {
      await enableCurrency();
      const id = await handlers['account-create']({
        name: 'Broker',
        offBudget: true,
      });
      expect(await currencyOf(id)).toBeNull();
      await handlers['account-set-currency']({ id, currency: 'EUR' });
      expect(await currencyOf(id)).toBe('EUR');
    });

    it('allows setting the global currency', async () => {
      await enableCurrency();
      const id = await handlers['account-create']({
        name: 'Broker',
        offBudget: true,
      });
      await handlers['account-set-currency']({ id, currency: 'USD' });
      expect(await currencyOf(id)).toBe('USD');
    });

    it('throws when the feature is inactive', async () => {
      const id = await handlers['account-create']({
        name: 'Broker',
        offBudget: true,
      });
      await expect(
        handlers['account-set-currency']({ id, currency: 'EUR' }),
      ).rejects.toThrow();
      await setPref('flags.currency', 'true');
      await expect(
        handlers['account-set-currency']({ id, currency: 'EUR' }),
      ).rejects.toThrow();
      expect(await currencyOf(id)).toBeNull();
    });

    it('throws for an unknown or empty code', async () => {
      await enableCurrency();
      const id = await handlers['account-create']({
        name: 'Broker',
        offBudget: true,
      });
      await expect(
        handlers['account-set-currency']({ id, currency: 'XXX' }),
      ).rejects.toThrow(/Unknown/);
      await expect(
        handlers['account-set-currency']({ id, currency: '' }),
      ).rejects.toThrow(/Unknown/);
    });

    it('throws for on-budget accounts', async () => {
      await enableCurrency();
      const id = await handlers['account-create']({ name: 'Checking' });
      await expect(
        handlers['account-set-currency']({ id, currency: 'EUR' }),
      ).rejects.toThrow(/off-budget/);
    });

    it('throws when a currency is already set, even to the same value', async () => {
      await enableCurrency();
      const id = await handlers['account-create']({
        name: 'Broker',
        offBudget: true,
      });
      await handlers['account-set-currency']({ id, currency: 'EUR' });
      await expect(
        handlers['account-set-currency']({ id, currency: 'EUR' }),
      ).rejects.toThrow(/cannot be changed/);
    });

    it('throws when a conflicting cross-currency transfer exists', async () => {
      await enableCurrency();
      const a = await handlers['account-create']({ name: 'Checking' });
      const b = await handlers['account-create']({
        name: 'Broker',
        offBudget: true,
      });
      await createTransfer(a, b);
      await expect(
        handlers['account-set-currency']({ id: b, currency: 'EUR' }),
      ).rejects.toThrow(/transfers/);
      await handlers['account-set-currency']({ id: b, currency: 'USD' });
      expect(await currencyOf(b)).toBe('USD');
    });
  });

  describe('account-create with currency', () => {
    it('creates an off-budget account with a currency', async () => {
      await enableCurrency();
      const id = await handlers['account-create']({
        name: 'Broker',
        offBudget: true,
        currency: 'EUR',
      });
      expect(await currencyOf(id)).toBe('EUR');
    });

    it('throws for on-budget accounts', async () => {
      await enableCurrency();
      await expect(
        handlers['account-create']({ name: 'Checking', currency: 'EUR' }),
      ).rejects.toThrow(/off-budget/);
    });

    it('uses the currency decimal places for the starting balance', async () => {
      await enableCurrency();
      const jpy = await handlers['account-create']({
        name: 'JP',
        offBudget: true,
        currency: 'JPY',
        balance: 1000,
      });
      const eur = await handlers['account-create']({
        name: 'EU',
        offBudget: true,
        currency: 'EUR',
        balance: 1000,
      });
      expect((await handlers['account-properties']({ id: jpy })).balance).toBe(
        1000,
      );
      expect((await handlers['account-properties']({ id: eur })).balance).toBe(
        100000,
      );
    });
  });

  describe('getCrossCurrencyTransfers', () => {
    it('lists each pair once and uses the global currency for NULL', async () => {
      await enableCurrency();
      const a = await handlers['account-create']({
        name: 'A',
        offBudget: true,
        currency: 'EUR',
      });
      const b = await handlers['account-create']({
        name: 'B',
        offBudget: true,
        currency: 'USD',
      });
      const c = await handlers['account-create']({ name: 'C' });
      await createTransfer(a, b);
      await createTransfer(b, a);
      await createTransfer(b, c); // USD <-> NULL(global USD): fine
      const result = await getCrossCurrencyTransfers({ globalCurrency: 'USD' });
      // Only the A/B pair conflicts; each pair is listed once (a.id < b.id)
      expect(result.length).toBe(1);
      expect(result.every(r => r.accountId < r.otherAccountId)).toBe(true);
    });
  });
});

describe('multi-currency handlers', () => {
  beforeEach(global.emptyDatabase());
  beforeEach(async () => {
    await prefs.loadPrefs();
  });

  it('reports unassigned off-budget accounts, open and closed, never on-budget', async () => {
    await enableCurrency();
    await handlers['account-create']({ name: 'On' });
    const open = await handlers['account-create']({
      name: 'Open',
      offBudget: true,
    });
    const closed = await handlers['account-create']({
      name: 'Closed',
      offBudget: true,
      closed: true,
    });
    await handlers['account-create']({
      name: 'Done',
      offBudget: true,
      currency: 'EUR',
    });
    const status = await handlers['multi-currency-status']();
    expect(status.isCurrencyActive).toBe(true);
    expect(status.globalCurrency).toBe('USD');
    expect(status.unassignedAccounts.map(a => a.id).sort()).toEqual(
      [open, closed].sort(),
    );
  });

  it('lists a cross-currency transfer pair once, using the global currency for NULL', async () => {
    await enableCurrency();
    const on = await handlers['account-create']({ name: 'On' });
    const eur = await handlers['account-create']({
      name: 'Eur',
      offBudget: true,
      currency: 'EUR',
    });
    await createTransfer(on, eur);
    await createTransfer(eur, on);
    const status = await handlers['multi-currency-status']();
    expect(status.crossCurrencyTransfers).toHaveLength(1);
    expect(status.crossCurrencyTransfers[0]).toMatchObject({
      accountName: expect.any(String),
      otherAccountName: expect.any(String),
    });
    // with EUR as the global currency, the NULL account is EUR too
    await setPref('defaultCurrencyCode', 'EUR');
    expect(
      (await handlers['multi-currency-status']()).crossCurrencyTransfers,
    ).toHaveLength(0);
    await setPref('defaultCurrencyCode', 'GBP');
    expect(
      (await handlers['multi-currency-status']()).crossCurrencyTransfers,
    ).toHaveLength(1);
  });

  it('returns an empty status when the currency feature is inactive', async () => {
    await handlers['account-create']({ name: 'Off', offBudget: true });
    const status = await handlers['multi-currency-status']();
    expect(status.isCurrencyActive).toBe(false);
    expect(status.unassignedAccounts).toEqual([]);
  });

  it('assigns the global currency to exactly the unassigned off-budget accounts', async () => {
    await enableCurrency('GBP');
    const on = await handlers['account-create']({ name: 'On' });
    const a = await handlers['account-create']({ name: 'A', offBudget: true });
    const b = await handlers['account-create']({
      name: 'B',
      offBudget: true,
      closed: true,
    });
    const c = await handlers['account-create']({
      name: 'C',
      offBudget: true,
      currency: 'EUR',
    });
    const result = await handlers['multi-currency-assign-default']();
    expect(result.count).toBe(2);
    const accounts = await handlers['accounts-get']();
    const byId = Object.fromEntries(accounts.map(x => [x.id, x.currency]));
    expect(byId[a]).toBe('GBP');
    expect(byId[b]).toBe('GBP');
    expect(byId[c]).toBe('EUR');
    expect(byId[on]).toBeNull();
    expect(
      (await handlers['multi-currency-status']()).unassignedAccounts,
    ).toEqual([]);
  });

  it('assign-default throws when the feature is inactive', async () => {
    await expect(handlers['multi-currency-assign-default']()).rejects.toThrow();
  });
});

describe('api/account-update', () => {
  const apiHandlers = installAPI({} as unknown as ServerHandlers);

  beforeEach(global.emptyDatabase());
  beforeEach(async () => {
    await prefs.loadPrefs();
    apiHandlers['account-update'] = accountsApp.handlers['account-update'];
    apiHandlers['account-set-currency'] =
      accountsApp.handlers['account-set-currency'];
    apiHandlers['account-create'] = accountsApp.handlers['account-create'];
    apiHandlers['accounts-get'] = accountsApp.handlers['accounts-get'];
  });

  it('updates the name and delegates the currency', async () => {
    await enableCurrency();
    const id = await apiHandlers['api/account-create']({
      account: { name: 'Broker', offbudget: true },
    });
    await apiHandlers['api/account-update']({
      id,
      fields: { id, name: 'Broker 2', currency: 'EUR' },
    });
    const [account] = await apiHandlers['api/accounts-get']();
    expect(account).toMatchObject({ name: 'Broker 2', currency: 'EUR' });
  });

  it('rejects offbudget, closed and unknown fields', async () => {
    const id = await apiHandlers['api/account-create']({
      account: { name: 'X' },
    });
    await expect(
      apiHandlers['api/account-update']({ id, fields: { offbudget: true } }),
    ).rejects.toThrow(/'offbudget' cannot be updated/);
    await expect(
      apiHandlers['api/account-update']({ id, fields: { closed: true } }),
    ).rejects.toThrow(/closeAccount\/reopenAccount/);
    await expect(
      apiHandlers['api/account-update']({ id, fields: { nope: 1 } as never }),
    ).rejects.toThrow(/'nope'/);
  });
});
