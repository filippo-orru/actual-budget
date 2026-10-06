import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as db from '#server/db';
import { handlers } from '#server/main';
import { runHandler } from '#server/mutators';
import { setSyncingMode } from '#server/sync';

beforeEach(async () => {
  setSyncingMode('offline');
  await global.emptyDatabase()();
  db.runQuery(
    "INSERT OR REPLACE INTO preferences (id, value) VALUES ('flags.multiCurrency', 'true')",
  );
});

afterEach(() => {
  setSyncingMode('disabled');
});

async function createBudget(name: string, currencyCode = 'USD') {
  db.runQuery("UPDATE budgets SET currency_code = 'USD' WHERE id = 'default'");
  return runHandler(handlers['budget-spaces/create'], { name, currencyCode });
}

describe('budget category ownership', () => {
  it('lists same-named category trees only in their owning budget', async () => {
    const second = await createBudget('Second');
    const groupA = await runHandler(handlers['category-group-create'], {
      budgetId: 'default',
      name: 'Food',
    });
    const groupB = await runHandler(handlers['category-group-create'], {
      budgetId: second.id,
      name: 'Food',
    });
    const categoryA = await runHandler(handlers['category-create'], {
      budgetId: 'default',
      name: 'Groceries',
      groupId: groupA,
    });
    const categoryB = await runHandler(handlers['category-create'], {
      budgetId: second.id,
      name: 'Groceries',
      groupId: groupB,
    });

    const resultA = await runHandler(handlers['get-categories'], {
      budgetId: 'default',
    });
    const resultB = await runHandler(handlers['get-categories'], {
      budgetId: second.id,
    });

    expect(resultA.list.map(category => category.id)).toContain(categoryA);
    expect(resultA.list.map(category => category.id)).not.toContain(categoryB);
    expect(resultB.list.map(category => category.id)).toContain(categoryB);
    expect(resultB.list.map(category => category.id)).not.toContain(categoryA);
    expect(resultA.grouped.map(group => group.id)).toContain(groupA);
    expect(resultA.grouped.map(group => group.id)).not.toContain(groupB);
    expect(resultB.grouped.map(group => group.id)).toContain(groupB);
    expect(resultB.grouped.map(group => group.id)).not.toContain(groupA);
  });

  it('rejects foreign group creation, ownership updates, and history remaps before writes', async () => {
    const second = await createBudget('Second');
    const groupA = await runHandler(handlers['category-group-create'], {
      budgetId: 'default',
      name: 'Food',
    });
    const groupB = await runHandler(handlers['category-group-create'], {
      budgetId: second.id,
      name: 'Food',
    });
    const source = await runHandler(handlers['category-create'], {
      budgetId: 'default',
      name: 'Source',
      groupId: groupA,
    });
    const target = await runHandler(handlers['category-create'], {
      budgetId: second.id,
      name: 'Target',
      groupId: groupB,
    });
    const foreignCleanup = await runHandler(
      handlers['budget/create-cleanup-group'],
      { budgetId: second.id, name: 'Foreign cleanup' },
    );
    const sourceCategory = await db.first<{
      id: string;
      budget_id: string;
      group: string;
    }>(
      `SELECT id, budget_id, cat_group AS "group" FROM categories WHERE id = ?`,
      [source],
    );
    const messagesBefore = await db.first<{ count: number }>(
      'SELECT count(*) AS count FROM messages_crdt',
    );
    expect(messagesBefore?.count).toBeGreaterThan(0);
    const mappingsBefore = await db.all(
      'SELECT * FROM category_mapping ORDER BY id',
    );

    await expect(
      runHandler(handlers['category-create'], {
        budgetId: 'default',
        name: 'Invalid',
        groupId: groupB,
      }),
    ).rejects.toThrow('Entity does not belong to the requested budget');
    await expect(
      runHandler(handlers['category-update'], {
        ...sourceCategory!,
        budget_id: second.id,
        name: 'Source',
        is_income: false,
        hidden: false,
      } as never),
    ).rejects.toThrow('Category ownership cannot be changed');
    await expect(
      runHandler(handlers['category-update'], {
        ...sourceCategory!,
        budget_id: 'default',
        cleanup_def: JSON.stringify([
          { role: 'source', groupId: foreignCleanup.id },
        ]),
      } as never),
    ).rejects.toThrow('Entity does not belong to the requested budget');
    await expect(
      runHandler(handlers['category-delete'], {
        id: source,
        transferId: target,
      }),
    ).rejects.toThrow('Entities must belong to the same budget');

    expect(await db.all('SELECT * FROM category_mapping ORDER BY id')).toEqual(
      mappingsBefore,
    );
    expect(
      await db.first<{ count: number }>(
        'SELECT count(*) AS count FROM messages_crdt',
      ),
    ).toEqual(messagesBefore);
  });
});
