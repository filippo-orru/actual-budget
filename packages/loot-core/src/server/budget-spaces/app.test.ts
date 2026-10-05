import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { setSyncingMode } from '#server/sync';
import { DEFAULT_DASHBOARD_STATE } from '#shared/dashboard';

import {
  assertBudgetOwner,
  assertSameBudgetOwner,
  getBudgetIdForEntity,
  resolveBudgetId,
} from './helpers';

beforeEach(async () => {
  setSyncingMode('offline');
  await global.emptyDatabase()();
});

afterEach(() => {
  setSyncingMode('disabled');
});

async function enableBudgetCreation() {
  db.runQuery(
    "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
  );
}

async function createBudget(name = 'Travel', currencyCode = 'USD') {
  await enableBudgetCreation();
  return runHandler(handlers['budget-spaces/create'], { name, currencyCode });
}

describe('budget spaces', () => {
  it('lists the migrated default budget without changing the file identity', async () => {
    const spaces = await runHandler(handlers['budget-spaces/get']);

    expect(spaces).toHaveLength(1);
    expect(await resolveBudgetId()).toBe('default');
    expect(spaces[0]).toMatchObject({
      id: 'default',
      name: 'Main',
      currency_code: '',
      budget_type: 'envelope',
      sort_order: 0,
      tombstone: false,
    });
  });

  it('creates independent budgets with owned minimal categories and dashboard defaults', async () => {
    const first = await createBudget('  Shared name  ', 'CAD');
    const second = await createBudget('Shared name', 'CAD');

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe('Shared name');
    expect(first).toMatchObject({
      currency_code: 'CAD',
      budget_type: 'envelope',
      tombstone: false,
    });

    const groups = await db.all<{
      budget_id: string;
      name: string;
      is_income: number;
    }>(
      'SELECT budget_id, name, is_income FROM category_groups WHERE budget_id IN (?, ?) ORDER BY budget_id, is_income DESC',
      [first.id, second.id],
    );
    expect(groups).toHaveLength(4);
    expect(
      groups.every(group => [first.id, second.id].includes(group.budget_id)),
    ).toBe(true);
    expect(groups.map(({ name, is_income }) => [name, is_income])).toEqual([
      ['Income', 1],
      ['Expenses', 0],
      ['Income', 1],
      ['Expenses', 0],
    ]);

    const categories = await db.all<{
      budget_id: string;
      group_budget_id: string;
      group_name: string;
      name: string;
      is_income: number;
    }>(
      `SELECT c.budget_id, g.budget_id AS group_budget_id, g.name AS group_name,
              c.name, c.is_income
       FROM categories c JOIN category_groups g ON g.id = c.cat_group
       WHERE c.budget_id IN (?, ?)`,
      [first.id, second.id],
    );
    expect(categories).toHaveLength(2);
    expect(
      categories.every(
        category =>
          category.budget_id === category.group_budget_id &&
          category.group_name === 'Income' &&
          category.name === 'Starting Balances' &&
          category.is_income === 1,
      ),
    ).toBe(true);

    const pages = await db.all<{ id: string; budget_id: string; name: string }>(
      'SELECT id, budget_id, name FROM dashboard_pages WHERE budget_id IN (?, ?)',
      [first.id, second.id],
    );
    expect(pages).toHaveLength(2);
    expect(pages.every(page => page.name === 'Main')).toBe(true);
    const widgets = await db.all<{ dashboard_page_id: string; type: string }>(
      `SELECT dashboard_page_id, type FROM dashboard
       WHERE dashboard_page_id IN (?, ?)`,
      pages.map(page => page.id),
    );
    expect(widgets).toHaveLength(DEFAULT_DASHBOARD_STATE.length * 2);
    expect(
      pages.every(
        page =>
          widgets.filter(widget => widget.dashboard_page_id === page.id)
            .length === DEFAULT_DASHBOARD_STATE.length,
      ),
    ).toBe(true);

    const messages = await db.all<{ dataset: string }>(
      'SELECT DISTINCT dataset FROM messages_crdt',
    );
    expect(messages.map(({ dataset }) => dataset)).toEqual(
      expect.arrayContaining([
        'budgets',
        'category_groups',
        'categories',
        'category_mapping',
        'dashboard_pages',
        'dashboard',
      ]),
    );
  });

  it('rejects creation when the multiple-budget feature is disabled', async () => {
    await expect(
      runHandler(handlers['budget-spaces/create'], {
        name: 'Blocked',
        currencyCode: 'USD',
      }),
    ).rejects.toThrow('Creating additional budgets is disabled');

    expect(await db.all('SELECT id FROM budgets')).toEqual([{ id: 'default' }]);
    expect(await db.all('SELECT id FROM messages_crdt')).toEqual([]);
  });

  it('rejects invalid create and update fields before any write', async () => {
    await enableBudgetCreation();
    await expect(
      runHandler(handlers['budget-spaces/create'], {
        name: '  ',
        currencyCode: 'USD',
      }),
    ).rejects.toThrow('Budget name must not be empty');
    await expect(
      runHandler(handlers['budget-spaces/create'], {
        name: 'Unknown currency',
        currencyCode: 'XXX',
      }),
    ).rejects.toThrow('Unknown currency code: XXX');
    await expect(
      runHandler(handlers['budget-spaces/create'], {
        name: 'Unexpected field',
        currencyCode: 'USD',
        budgetId: 'default',
      } as never),
    ).rejects.toThrow('Unexpected budget-space field: budgetId');

    const created = await createBudget();
    await expect(
      runHandler(handlers['budget-spaces/update'], {
        id: created.id,
        currencyCode: 'XXX',
      }),
    ).rejects.toThrow('Unknown currency code: XXX');
    await expect(
      runHandler(handlers['budget-spaces/update'], {
        id: created.id,
        budget_id: 'default',
      } as never),
    ).rejects.toThrow('Unexpected budget-space field: budget_id');
    await expect(
      runHandler(handlers['budget-spaces/update'], {
        id: created.id,
        name: '   ',
      }),
    ).rejects.toThrow('Budget name must not be empty');

    expect(
      await db.first<{ name: string; currency_code: string }>(
        'SELECT name, currency_code FROM budgets WHERE id = ?',
        [created.id],
      ),
    ).toEqual({ name: 'Travel', currency_code: 'USD' });
  });

  it('rolls back the complete create batch when scaffold insertion fails', async () => {
    await enableBudgetCreation();
    const existingBudgets = await db.all('SELECT id FROM budgets');
    const existingGroups = await db.all('SELECT id FROM category_groups');
    const existingCategories = await db.all('SELECT id FROM categories');
    const existingPages = await db.all('SELECT id FROM dashboard_pages');
    const existingWidgets = await db.all('SELECT id FROM dashboard');
    const existingMessages = await db.all('SELECT id FROM messages_crdt');
    db.execQuery(`
      CREATE TRIGGER fail_budget_widget_insert BEFORE INSERT ON dashboard
      BEGIN SELECT RAISE(ABORT, 'widget insert failed'); END;
    `);

    await expect(createBudget()).rejects.toMatchObject({
      reason: 'invalid-schema',
      meta: {
        error: { message: expect.stringContaining('widget insert failed') },
      },
    });

    expect(await db.all('SELECT id FROM budgets')).toEqual(existingBudgets);
    expect(await db.all('SELECT id FROM category_groups')).toEqual(
      existingGroups,
    );
    expect(await db.all('SELECT id FROM categories')).toEqual(
      existingCategories,
    );
    expect(await db.all('SELECT id FROM dashboard_pages')).toEqual(
      existingPages,
    );
    expect(await db.all('SELECT id FROM dashboard')).toEqual(existingWidgets);
    expect(await db.all('SELECT id FROM messages_crdt')).toEqual(
      existingMessages,
    );
  });

  it('updates only the target budget row and preserves stored financial amounts', async () => {
    const created = await createBudget();
    await db.insertAccount({
      budget_id: 'default',
      id: 'cash',
      name: 'Cash',
    });
    await db.insertTransaction({
      id: 'cash-opening',
      account: 'cash',
      amount: 12345,
      date: '2024-01-01',
    });
    db.runQuery(
      `INSERT INTO zero_budgets (id, budget_id, month, category, amount)
       VALUES ('2024-01-category', 'default', 202401, 'category', -4321)`,
    );

    const transactions = await db.all('SELECT * FROM transactions');
    const zeroBudgets = await db.all('SELECT * FROM zero_budgets');
    const accounts = await db.all('SELECT * FROM accounts');
    const budgetMessagesBefore = await db.all<{
      dataset: string;
      row: string;
      column: string;
    }>(
      'SELECT dataset, row, column FROM messages_crdt WHERE dataset = ? AND row = ? ORDER BY rowid',
      ['budgets', created.id],
    );

    const updated = await runHandler(handlers['budget-spaces/update'], {
      id: created.id,
      currencyCode: 'JPY',
    });

    expect(updated.currency_code).toBe('JPY');
    expect(await db.all('SELECT * FROM transactions')).toEqual(transactions);
    expect(await db.all('SELECT * FROM zero_budgets')).toEqual(zeroBudgets);
    expect(await db.all('SELECT * FROM accounts')).toEqual(accounts);
    expect(
      await db.all<{ dataset: string; row: string; column: string }>(
        'SELECT dataset, row, column FROM messages_crdt WHERE dataset = ? AND row = ? ORDER BY rowid',
        ['budgets', created.id],
      ),
    ).toEqual([
      ...budgetMessagesBefore,
      { dataset: 'budgets', row: created.id, column: 'currency_code' },
    ]);
    expect(
      await db.first<{ currency_code: string }>(
        'SELECT currency_code FROM budgets WHERE id = ?',
        [created.id],
      ),
    ).toEqual({ currency_code: 'JPY' });
  });

  it('allows clearing the currency while only one active budget exists', async () => {
    await runHandler(handlers['budget-spaces/update'], {
      id: 'default',
      currencyCode: 'USD',
    });

    const updated = await runHandler(handlers['budget-spaces/update'], {
      id: 'default',
      currencyCode: '',
    });

    expect(updated.currency_code).toBe('');
    expect(
      await db.first<{ currency_code: string }>(
        'SELECT currency_code FROM budgets WHERE id = ?',
        ['default'],
      ),
    ).toEqual({ currency_code: '' });
  });

  it('rejects clearing any currency when multiple active budgets exist before writing', async () => {
    const created = await createBudget('Second budget');
    const beforeMessages = await db.all('SELECT * FROM messages_crdt');

    await expect(
      runHandler(handlers['budget-spaces/update'], {
        id: 'default',
        currencyCode: '',
      }),
    ).rejects.toThrow(
      'Budget currency cannot be cleared while multiple budgets exist',
    );

    expect(
      await db.first<{ currency_code: string }>(
        'SELECT currency_code FROM budgets WHERE id = ?',
        ['default'],
      ),
    ).toEqual({ currency_code: '' });
    expect(await db.all('SELECT * FROM messages_crdt')).toEqual(beforeMessages);
    expect(created.currency_code).toBe('USD');
  });

  it('changes budget type without resetting another budget or stored amounts', async () => {
    const created = await createBudget('Tracking candidate');
    db.runQuery(
      `INSERT INTO zero_budgets (id, budget_id, month, category, amount)
       VALUES ('target-buffer', ?, 202401, 'category', 9876)`,
      [created.id],
    );
    const zeroBudgets = await db.all('SELECT * FROM zero_budgets');

    const updated = await runHandler(handlers['budget-spaces/update'], {
      id: created.id,
      budgetType: 'tracking',
    });

    expect(updated.budget_type).toBe('tracking');
    expect(
      await db.first<{ budget_type: string }>(
        'SELECT budget_type FROM budgets WHERE id = ?',
        ['default'],
      ),
    ).toEqual({ budget_type: 'envelope' });
    expect(await db.all('SELECT * FROM zero_budgets')).toEqual(zeroBudgets);
    expect(
      await db.all<{ dataset: string; row: string; column: string }>(
        'SELECT dataset, row, column FROM messages_crdt WHERE dataset = ? AND row = ? ORDER BY rowid',
        ['budgets', created.id],
      ),
    ).toEqual([
      { dataset: 'budgets', row: created.id, column: 'name' },
      { dataset: 'budgets', row: created.id, column: 'currency_code' },
      { dataset: 'budgets', row: created.id, column: 'budget_type' },
      { dataset: 'budgets', row: created.id, column: 'sort_order' },
      { dataset: 'budgets', row: created.id, column: 'tombstone' },
      { dataset: 'budgets', row: created.id, column: 'budget_type' },
    ]);
  });

  it('resolves entity ownership and rejects ambiguous implicit budget selection', async () => {
    const first = await createBudget('First');
    const second = await createBudget('Second');
    const firstPage = await db.first<{ id: string }>(
      'SELECT id FROM dashboard_pages WHERE budget_id = ?',
      [first.id],
    );
    const secondPage = await db.first<{ id: string }>(
      'SELECT id FROM dashboard_pages WHERE budget_id = ?',
      [second.id],
    );
    if (!firstPage || !secondPage) {
      throw new Error('Expected created dashboard pages');
    }

    expect(
      await getBudgetIdForEntity({
        table: 'dashboard_pages',
        id: firstPage.id,
      }),
    ).toBe(first.id);
    const firstWidget = await db.first<{ id: string }>(
      'SELECT id FROM dashboard WHERE dashboard_page_id = ? LIMIT 1',
      [firstPage.id],
    );
    if (!firstWidget) {
      throw new Error('Expected a default dashboard widget');
    }
    expect(
      await getBudgetIdForEntity({ table: 'dashboard', id: firstWidget.id }),
    ).toBe(first.id);
    await db.insertAccount({
      id: 'first-account',
      budget_id: first.id,
      name: 'Owned account',
    });
    await db.insertTransaction({
      id: 'first-transaction',
      account: 'first-account',
      amount: 123,
      date: '2024-01-01',
    });
    expect(
      await getBudgetIdForEntity({
        table: 'transactions',
        id: 'first-transaction',
      }),
    ).toBe(first.id);
    db.runQuery(
      `INSERT INTO schedules (id, budget_id, rule)
       VALUES ('schedule-for-next-date', ?, 'schedule-rule')`,
      [first.id],
    );
    db.runQuery(
      `INSERT INTO schedules_next_date (id, schedule_id)
       VALUES ('independent-next-date-row', 'schedule-for-next-date')`,
    );
    expect(
      await getBudgetIdForEntity({
        table: 'schedules_next_date',
        id: 'independent-next-date-row',
      }),
    ).toBe(first.id);
    await expect(
      getBudgetIdForEntity({
        table: 'schedules_next_date',
        id: 'unknown-next-date-row',
      }),
    ).rejects.toThrow(
      'schedules_next_date entity not found: unknown-next-date-row',
    );
    expect(
      await assertSameBudgetOwner([
        { table: 'dashboard_pages', id: firstPage.id },
        { table: 'dashboard_pages', id: firstPage.id },
      ]),
    ).toBe(first.id);
    await expect(
      assertSameBudgetOwner([
        { table: 'dashboard_pages', id: firstPage.id },
        { table: 'dashboard_pages', id: secondPage.id },
      ]),
    ).rejects.toThrow('Entities must belong to the same budget');
    await expect(
      assertBudgetOwner(first.id, [
        { table: 'dashboard_pages', id: secondPage.id },
      ]),
    ).rejects.toThrow('Entity does not belong to the requested budget');
    await expect(resolveBudgetId()).rejects.toThrow(
      'budgetId is required when a file contains multiple budgets',
    );
    expect(await resolveBudgetId(first.id)).toBe(first.id);
  });
});
