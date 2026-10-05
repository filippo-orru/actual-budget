import * as db from '#server/db';
import * as sheet from '#server/sheet';
import { getBankSyncError } from '#shared/errors';
import type { ServerHandlers } from '#types/server-handlers';

import { app as accountGroupsApp } from './account-groups/app';
import { app as accountsApp } from './accounts/app';
import { installAPI } from './api';
import { createBudget } from './budget/base';
import * as prefs from './prefs';

vi.mock('#shared/errors', () => ({
  getBankSyncError: vi.fn(error => `Bank sync error: ${error}`),
}));

describe('API handlers', () => {
  const handlers = installAPI({} as unknown as ServerHandlers);

  describe('api/get-server-version', () => {
    beforeEach(() => {
      prefs.unloadPrefs();
    });

    it('does not require an open budget', async () => {
      handlers['get-server-version'] = vi
        .fn()
        .mockResolvedValue({ version: '26.6.0' });

      await expect(handlers['api/get-server-version']()).resolves.toEqual({
        version: '26.6.0',
      });
    });
  });

  describe('api/bank-sync', () => {
    it('should sync a single account when accountId is provided', async () => {
      handlers['accounts-bank-sync'] = vi
        .fn()
        .mockResolvedValue({ errors: [] });

      await handlers['api/bank-sync']({ accountId: 'account1' });
      expect(handlers['accounts-bank-sync']).toHaveBeenCalledWith({
        ids: ['account1'],
      });
    });

    it('should handle errors in non batch sync', async () => {
      handlers['accounts-bank-sync'] = vi.fn().mockResolvedValue({
        errors: ['connection-failed'],
      });

      await expect(
        handlers['api/bank-sync']({ accountId: 'account2' }),
      ).rejects.toThrow('Bank sync error: connection-failed');

      expect(getBankSyncError).toHaveBeenCalledWith('connection-failed');
    });
  });

  describe('api/account-groups', () => {
    beforeEach(global.emptyDatabase());

    beforeEach(async () => {
      await prefs.loadPrefs();

      handlers['account-groups-get'] =
        accountGroupsApp.handlers['account-groups-get'];
      handlers['account-group-create'] =
        accountGroupsApp.handlers['account-group-create'];
      handlers['account-group-update'] =
        accountGroupsApp.handlers['account-group-update'];
      handlers['account-group-delete'] =
        accountGroupsApp.handlers['account-group-delete'];
      handlers['accounts-get'] = accountsApp.handlers['accounts-get'];
      handlers['account-update'] = accountsApp.handlers['account-update'];
      handlers['account-create'] = accountsApp.handlers['account-create'];
    });

    it('rejects an account owner supplied inside arbitrary API fields', async () => {
      await expect(
        handlers['api/account-create']({
          account: { name: 'Wrong owner', budget_id: 'default' } as never,
        }),
      ).rejects.toThrow(
        "Field 'budget_id' cannot be set when creating an account",
      );
    });

    it('creates accounts without storing a currency field', async () => {
      const id = await handlers['account-create']({
        budgetId: 'default',
        name: 'Off-budget account',
        offBudget: true,
      });
      const account = await db.first('SELECT * FROM accounts WHERE id = ?', [
        id,
      ]);
      expect(account).not.toHaveProperty('currency');
    });

    it('rejects currency updates while allowing name and group edits', async () => {
      const groupId = await handlers['api/account-group-create']({
        group: { name: 'Savings' },
      });
      await db.insertAccount({
        budget_id: 'default',
        id: 'acct1',
        name: 'Checking',
      });

      await handlers['api/account-update']({
        id: 'acct1',
        fields: { name: 'Emergency fund', account_group_id: groupId },
      });
      const unsupportedFields = { name: undefined, currency: 'EUR' };
      await expect(
        handlers['api/account-update']({
          id: 'acct1',
          fields: unsupportedFields,
        }),
      ).rejects.toThrow("Field 'currency' cannot be updated");
      await expect(
        handlers['api/account-update']({
          id: 'acct1',
          fields: { budget_id: 'another-budget' } as never,
        }),
      ).rejects.toThrow("Field 'budget_id' cannot be updated");

      const account = (
        await handlers['accounts-get']({ budgetId: 'default' })
      )[0];
      expect(account).toMatchObject({
        id: 'acct1',
        name: 'Emergency fund',
        account_group_id: groupId,
      });
      expect(account).not.toHaveProperty('currency');
    });

    it('requires owner context in multi-budget files and scopes public account lists', async () => {
      await db.insertWithSchema('budgets', {
        id: 'second-budget',
        name: 'Second',
        currency_code: 'USD',
        budget_type: 'envelope',
        sort_order: 1000,
        tombstone: false,
      });
      await db.insertAccount({
        id: 'first-account',
        budget_id: 'default',
        name: 'Checking',
      });
      await db.insertAccount({
        id: 'second-account',
        budget_id: 'second-budget',
        name: 'Checking',
      });

      await expect(handlers['api/accounts-get']()).rejects.toThrow(
        'budgetId is required when a file contains multiple budgets',
      );
      await expect(
        handlers['api/accounts-get']({ budgetId: 'second-budget' }),
      ).resolves.toMatchObject([{ id: 'second-account', name: 'Checking' }]);
    });

    it('creates an API account and opening balance in the explicit budget', async () => {
      await db.insertWithSchema('budgets', {
        id: 'euro-budget',
        name: 'Euro',
        currency_code: 'EUR',
        budget_type: 'envelope',
        sort_order: 1000,
        tombstone: false,
      });
      db.runQuery(
        "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.currency', 'true')",
      );
      const incomeGroup = await db.insertCategoryGroup({
        budget_id: 'euro-budget',
        name: 'Income',
        is_income: 1,
      });
      await db.insertCategory({
        budget_id: 'euro-budget',
        name: 'Starting Balances',
        cat_group: incomeGroup,
        is_income: 1,
      });

      const accountId = await handlers['api/account-create']({
        budgetId: 'euro-budget',
        account: { name: 'Checking' },
        initialBalance: 1234,
      });
      const opening = await db.first<{
        amount: number;
        category_budget_id: string;
      }>(
        `SELECT t.amount, c.budget_id AS category_budget_id
         FROM transactions t JOIN categories c ON c.id = t.category
         WHERE t.acct = ?`,
        [accountId],
      );
      expect(opening).toEqual({
        amount: 1234,
        category_budget_id: 'euro-budget',
      });
    });

    it('round-trips account groups and exposes account_group_id on accounts', async () => {
      const id = await handlers['api/account-group-create']({
        group: { name: 'Savings' },
      });
      await expect(handlers['api/account-groups-get']()).resolves.toEqual([
        { id, name: 'Savings' },
      ]);

      await handlers['api/account-group-update']({
        id,
        fields: { name: 'ISAs' },
      });
      await expect(handlers['api/account-groups-get']()).resolves.toEqual([
        { id, name: 'ISAs' },
      ]);

      await db.insertAccount({
        budget_id: 'default',
        id: 'acct1',
        name: 'Marcus',
      });
      await handlers['api/account-update']({
        id: 'acct1',
        fields: { account_group_id: id },
      });
      const accounts = await handlers['api/accounts-get']();
      expect(accounts[0]).toMatchObject({ id: 'acct1', account_group_id: id });

      await handlers['api/account-group-delete']({ id });
      await expect(handlers['api/account-groups-get']()).resolves.toEqual([]);
      const after = await handlers['api/accounts-get']();
      expect(after[0].account_group_id).toBeNull();
    });
  });

  describe('api/budget-month', () => {
    beforeEach(global.emptyDatabase());

    beforeEach(async () => {
      global.currentMonth = '2026-01';

      await sheet.loadSpreadsheet(db);
      await prefs.loadPrefs();

      await db.insertCategoryGroup({
        budget_id: 'default',
        id: 'income-group',
        name: 'Income',
        is_income: 1,
      });
      await db.insertCategory({
        id: 'income-cat',
        name: 'Salary',
        cat_group: 'income-group',
        is_income: 1,
      });

      await db.insertAccount({
        budget_id: 'default',
        id: 'acct1',
        name: 'Checking',
      });

      handlers['get-budget-bounds'] = vi
        .fn()
        .mockResolvedValue({ start: '2026-01', end: '2026-12' });
    });

    afterEach(() => {
      global.currentMonth = null;
    });

    it('envelope budget: income group returns only received', async () => {
      await createBudget(['2026-02', '2026-03']);
      await db.insertTransaction({
        id: 'tx1',
        date: '2026-03-15',
        account: 'acct1',
        amount: 5000,
        category: 'income-cat',
      });
      await sheet.waitOnSpreadsheet();

      const result = await handlers['api/budget-month']({ month: '2026-03' });
      const group = result.categoryGroups.find(g => g.is_income);
      assert(group, 'Expected income category group to exist');

      expect(group).toHaveProperty('received', 5000);
      expect(group).not.toHaveProperty('budgeted');
      expect(group).not.toHaveProperty('balance');
      expect(group?.categories?.[0]).toHaveProperty('received', 5000);
      expect(group?.categories?.[0]).not.toHaveProperty('budgeted');
      expect(group?.categories?.[0]).not.toHaveProperty('balance');
    });

    it('tracking budget: income group returns budgeted, received, and balance', async () => {
      sheet.get().meta().budgetType = 'tracking';
      await db.update('preferences', { id: 'budgetType', value: 'tracking' });

      await createBudget(['2026-02', '2026-03']);
      sheet.get().set('budget202603!budget-income-cat', 6000);
      await db.insertTransaction({
        id: 'tx1',
        date: '2026-03-15',
        account: 'acct1',
        amount: 5000,
        category: 'income-cat',
      });
      await sheet.waitOnSpreadsheet();

      const result = await handlers['api/budget-month']({ month: '2026-03' });
      const group = result.categoryGroups.find(g => g.is_income);
      assert(group, 'Expected income category group to exist');

      expect(group).toHaveProperty('budgeted', 6000);
      expect(group).toHaveProperty('received', 5000);
      expect(group).toHaveProperty('balance', 1000);
      expect(group?.categories?.[0]).toHaveProperty('budgeted', 6000);
      expect(group?.categories?.[0]).toHaveProperty('received', 5000);
      expect(group?.categories?.[0]).toHaveProperty('balance', 1000);
      expect(group?.categories?.[0]).toHaveProperty('carryover', false);
    });
  });

  describe('api/rule-create', () => {
    beforeEach(global.emptyDatabase());

    beforeEach(async () => {
      await prefs.loadPrefs();
    });

    test.each(['default', null, 'pre', 'post'] as const)(
      'normalizes %s input at the API boundary',
      async stage => {
        const rule = {
          stage,
          conditionsOp: 'and' as const,
          conditions: [],
          actions: [],
        };
        const internalRule = {
          id: 'rule-id',
          budget_id: 'default',
          ...rule,
          stage: stage === 'default' ? null : stage,
        };

        handlers['rule-add'] = vi.fn().mockResolvedValue(internalRule);

        await expect(handlers['api/rule-create']({ rule })).resolves.toEqual(
          internalRule,
        );
        expect(handlers['rule-add']).toHaveBeenCalledWith({
          ...rule,
          budget_id: 'default',
          stage: internalRule.stage,
        });
      },
    );
  });

  describe('api/rule-update', () => {
    beforeEach(global.emptyDatabase());

    beforeEach(async () => {
      await prefs.loadPrefs();
    });

    test('normalizes default input at the API boundary', async () => {
      await db.insertWithSchema('rules', {
        id: 'rule-id',
        budget_id: 'default',
        stage: 'pre',
        conditions: [],
        actions: [],
      });
      const rule = {
        id: 'rule-id',
        stage: 'default' as const,
        conditionsOp: 'and' as const,
        conditions: [],
        actions: [],
      };
      const internalRule = { ...rule, budget_id: 'default', stage: null };

      handlers['rule-update'] = vi.fn().mockResolvedValue(internalRule);

      await expect(handlers['api/rule-update']({ rule })).resolves.toEqual(
        internalRule,
      );
      expect(handlers['rule-update']).toHaveBeenCalledWith(internalRule);
    });
  });
});
