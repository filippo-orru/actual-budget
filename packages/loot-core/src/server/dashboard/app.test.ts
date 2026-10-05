import { describe, expect, it } from 'vitest';

import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { q } from '#shared/query';
import type { DashboardWidgetEntity } from '#types/models';

import { app, isWidgetType } from './app';

function allWidgetTypes<T extends DashboardWidgetEntity['type'][]>(
  ...types: T &
    (DashboardWidgetEntity['type'] extends T[number] ? unknown : never)
): T {
  return types;
}

const ALL_WIDGET_TYPES = allWidgetTypes(
  'net-worth-card',
  'cash-flow-card',
  'spending-card',
  'crossover-card',
  'budget-analysis-card',
  'markdown-card',
  'summary-card',
  'calendar-card',
  'formula-card',
  'custom-report',
  'sankey-card',
  'balance-forecast-card',
  'age-of-money-card',
  'monte-carlo-card',
);

describe('dashboard budget ownership', () => {
  it('rejects copying a widget to another budget page', async () => {
    await global.emptyDatabase()();
    await db.insertWithSchema('budgets', {
      id: 'budget-b',
      name: 'Budget B',
      currency_code: 'USD',
      budget_type: 'envelope',
      sort_order: 1,
    });
    const pageA = await app.handlers['dashboard-create']({
      name: 'Dashboard A',
      budgetId: 'default',
    });
    const pageB = await app.handlers['dashboard-create']({
      name: 'Dashboard B',
      budgetId: 'budget-b',
    });
    await app.handlers['dashboard-add-widget']({
      type: 'markdown-card',
      width: 4,
      height: 3,
      dashboard_page_id: pageA,
      meta: { content: 'Budget A' },
    });
    const widget = await db.first<{ id: string }>(
      'SELECT id FROM dashboard WHERE dashboard_page_id = ?',
      [pageA],
    );
    if (!widget) {
      throw new Error('Expected dashboard widget to be created');
    }
    const { data: widgetsA }: { data: Array<{ id: string }> } = await aqlQuery(
      q('dashboard')
        .filter({ 'dashboard_page_id.budget_id': 'default' })
        .select(['id']),
    );
    expect(widgetsA.map(row => row.id)).toContain(widget.id);

    await expect(
      app.handlers['dashboard-copy-widget']({
        id: widget.id,
        targetDashboardPageId: pageB,
      }),
    ).rejects.toThrow('cannot be copied between budgets');
  });
});

describe('isWidgetType', () => {
  it('all known widget types should be recognized', () => {
    for (const type of ALL_WIDGET_TYPES) {
      expect(isWidgetType(type)).toBe(true);
    }
  });

  it('unknown widget types should be rejected', () => {
    expect(isWidgetType('unknown-card')).toBe(false);
  });
});
