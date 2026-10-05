import { isMatch } from 'es-toolkit/compat';
import { v4 as uuidv4 } from 'uuid';

import { captureException } from '#platform/exceptions';
import * as fs from '#platform/server/fs';
import { createApp } from '#server/app';
import { aqlQuery } from '#server/aql';
import {
  assertBudgetOwner,
  getBudgetIdForEntity,
  validateBudgetExists,
} from '#server/budget-spaces/helpers';
import * as db from '#server/db';
import { ValidationError } from '#server/errors';
import { requiredFields } from '#server/models';
import { mutator } from '#server/mutators';
import { reportModel, validateReportReferences } from '#server/reports/app';
import { batchMessages } from '#server/sync';
import { undoable } from '#server/undo';
import { DEFAULT_DASHBOARD_STATE } from '#shared/dashboard';
import { q } from '#shared/query';
import type {
  DashboardWidgetEntity,
  ExportImportCustomReportWidget,
  ExportImportDashboard,
  ExportImportDashboardWidget,
} from '#types/models';
import type { EverythingButIdOptional, WithOptional } from '#types/util';

function isExportedCustomReportWidget(
  widget: ExportImportDashboardWidget,
): widget is ExportImportCustomReportWidget {
  return widget.type === 'custom-report';
}

export function isWidgetType(
  type: string,
): type is DashboardWidgetEntity['type'] {
  return [
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
  ].includes(type);
}

const exportModel = {
  validate(dashboard: ExportImportDashboard) {
    requiredFields('Dashboard', dashboard, ['version', 'widgets']);

    if (!Array.isArray(dashboard.widgets)) {
      throw new ValidationError(
        'Invalid dashboard.widgets data type: it must be an array of widgets.',
      );
    }

    dashboard.widgets.forEach((widget, idx) => {
      requiredFields(`Dashboard widget #${idx}`, widget, [
        'type',
        'x',
        'y',
        'width',
        'height',
        ...(isExportedCustomReportWidget(widget) ? ['meta' as const] : []),
      ]);

      if (!Number.isInteger(widget.x)) {
        throw new ValidationError(
          `Invalid widget.${idx}.x data-type for value ${widget.x}.`,
        );
      }

      if (!Number.isInteger(widget.y)) {
        throw new ValidationError(
          `Invalid widget.${idx}.y data-type for value ${widget.y}.`,
        );
      }

      if (!Number.isInteger(widget.width)) {
        throw new ValidationError(
          `Invalid widget.${idx}.width data-type for value ${widget.width}.`,
        );
      }

      if (!Number.isInteger(widget.height)) {
        throw new ValidationError(
          `Invalid widget.${idx}.height data-type for value ${widget.height}.`,
        );
      }

      if (!isWidgetType(widget.type)) {
        throw new ValidationError(
          `Invalid widget.${idx}.type value ${String(widget.type)}.`,
        );
      }

      if (isExportedCustomReportWidget(widget)) {
        reportModel.validate(widget.meta);
      }
    });
  },
};

async function createDashboardPage({
  name,
  budgetId,
}: {
  name: string;
  budgetId: string;
}) {
  await validateBudgetExists(budgetId);
  const id = uuidv4();
  await db.insertWithSchema('dashboard_pages', {
    id,
    budget_id: budgetId,
    name,
  });

  return id;
}

async function deleteDashboardPage(id: string) {
  const budgetId = await getBudgetIdForEntity({ table: 'dashboard_pages', id });
  const res = await db.first<{ c: number }>(
    'SELECT count(*) as c FROM dashboard_pages WHERE tombstone = 0 AND budget_id = ?',
    [budgetId],
  );

  if ((res?.c ?? 0) <= 1) {
    throw new Error('Cannot delete the last dashboard page');
  }

  const deleting_widgets = await db.all<Pick<db.DbDashboard, 'id'>>(
    'SELECT id FROM dashboard WHERE dashboard_page_id = ? AND tombstone = 0',
    [id],
  );

  await batchMessages(async () => {
    await db.delete_('dashboard_pages', id);
    // Tombstone all widgets for this dashboard
    await Promise.all(
      deleting_widgets.map(({ id }) => db.delete_('dashboard', id)),
    );
  });
}

async function renameDashboardPage({ id, name }: { id: string; name: string }) {
  await getBudgetIdForEntity({ table: 'dashboard_pages', id });
  await db.updateWithSchema('dashboard_pages', { id, name });
}

async function validateWidgetReferences(
  widget: Partial<Pick<DashboardWidgetEntity, 'type' | 'meta'>>,
  budgetId: string,
  allowPendingCustomReport = false,
) {
  const meta =
    typeof widget.meta === 'string' ? JSON.parse(widget.meta) : widget.meta;
  const references: Array<{
    table: 'accounts' | 'categories' | 'category_groups' | 'custom_reports';
    id: string;
  }> = [];
  function visit(value: unknown, key = '') {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      const table = ['accountId', 'accountIds', 'incomeAccountIds'].includes(
        key,
      )
        ? 'accounts'
        : ['categoryId', 'categoryIds', 'expenseCategoryIds'].includes(key)
          ? 'categories'
          : null;
      if (table && typeof value === 'string' && value.length > 0) {
        references.push({ table, id: value });
      }
      return;
    }
    if ('field' in value && 'value' in value) {
      const condition = value as {
        field?: string;
        op?: string;
        value?: unknown;
      };
      const table =
        condition.field === 'account'
          ? 'accounts'
          : condition.field === 'category'
            ? 'categories'
            : condition.field === 'category_group'
              ? 'category_groups'
              : null;
      if (table) {
        const ids =
          condition.op === 'oneOf' || condition.op === 'notOneOf'
            ? condition.value
            : [condition.value];
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (typeof id === 'string' && id.length > 0) {
              references.push({ table, id });
            }
          }
        }
      }
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      visit(childValue, childKey);
    }
  }
  visit(meta);
  if (
    !allowPendingCustomReport &&
    widget.type === 'custom-report' &&
    typeof meta?.id === 'string'
  ) {
    references.push({ table: 'custom_reports', id: meta.id });
  }
  if (references.length > 0) {
    await assertBudgetOwner(budgetId, references);
  }
}

async function updateDashboard(
  widgets: EverythingButIdOptional<Omit<DashboardWidgetEntity, 'tombstone'>>[],
) {
  for (const widget of widgets) {
    const owner = await getBudgetIdForEntity({
      table: 'dashboard',
      id: widget.id,
    });
    const targetOwner = widget.dashboard_page_id
      ? await getBudgetIdForEntity({
          table: 'dashboard_pages',
          id: widget.dashboard_page_id,
        })
      : owner;
    if (owner !== targetOwner) {
      throw new ValidationError(
        'Dashboard widgets cannot move between budgets',
      );
    }
    await validateWidgetReferences(widget, owner);
  }
  const { data: dbWidgets } = await aqlQuery(
    q('dashboard')
      .filter({ id: { $oneof: widgets.map(({ id }) => id) } })
      .select('*'),
  );
  const dbWidgetMap = new Map(
    (dbWidgets as DashboardWidgetEntity[]).map(widget => [widget.id, widget]),
  );

  await Promise.all(
    widgets
      // Perform an update query only if the widget actually has changes
      .filter(widget => !isMatch(dbWidgetMap.get(widget.id) ?? {}, widget))
      .map(widget => db.update('dashboard', widget)),
  );
}

async function updateDashboardWidget(
  widget: EverythingButIdOptional<Omit<DashboardWidgetEntity, 'tombstone'>>,
) {
  const owner = await getBudgetIdForEntity({
    table: 'dashboard',
    id: widget.id,
  });
  if (widget.dashboard_page_id) {
    const targetOwner = await getBudgetIdForEntity({
      table: 'dashboard_pages',
      id: widget.dashboard_page_id,
    });
    if (owner !== targetOwner) {
      throw new ValidationError(
        'Dashboard widgets cannot move between budgets',
      );
    }
  }
  await validateWidgetReferences(widget, owner);
  await db.updateWithSchema('dashboard', widget);
}

async function resetDashboard(id: string) {
  await getBudgetIdForEntity({ table: 'dashboard_pages', id });
  await batchMessages(async () => {
    const widgets = await db.selectWithSchema(
      'dashboard',
      'SELECT id FROM dashboard WHERE dashboard_page_id = ? AND tombstone = 0',
      [id],
    );

    await Promise.all([
      // Delete all widgets for this dashboard
      ...widgets.map(({ id }) => db.delete_('dashboard', id)),

      // Insert the default state
      ...DEFAULT_DASHBOARD_STATE.map(widget =>
        db.insertWithSchema('dashboard', { ...widget, dashboard_page_id: id }),
      ),
    ]);
  });
}

async function addDashboardWidget(
  widget: WithOptional<
    Omit<DashboardWidgetEntity, 'id' | 'tombstone'>,
    'x' | 'y'
  >,
) {
  const budgetId = await getBudgetIdForEntity({
    table: 'dashboard_pages',
    id: widget.dashboard_page_id,
  });
  await validateWidgetReferences(widget, budgetId);
  // If no x & y was provided - calculate it dynamically
  // The new widget should be the very last one in the list of all widgets
  if (!('x' in widget) && !('y' in widget)) {
    const data = await db.first<
      Pick<db.DbDashboard, 'x' | 'y' | 'width' | 'height'>
    >(
      'SELECT x, y, width, height FROM dashboard WHERE dashboard_page_id = ? AND tombstone = 0 ORDER BY y DESC, x DESC',
      [widget.dashboard_page_id],
    );

    if (!data) {
      widget.x = 0;
      widget.y = 0;
    } else {
      const xBoundaryCheck = data.x + data.width + widget.width;
      widget.x = xBoundaryCheck > 12 ? 0 : data.x + data.width;
      widget.y = data.y + (xBoundaryCheck > 12 ? data.height : 0);
    }
  }

  const { dashboard_page_id, ...widgetWithoutDashboardPageId } = widget;

  await db.insertWithSchema('dashboard', {
    ...widgetWithoutDashboardPageId,
    dashboard_page_id,
  });
}

async function removeDashboardWidget(widgetId: string) {
  await db.delete_('dashboard', widgetId);
}

async function copyDashboardWidget({
  id,
  targetDashboardPageId,
}: {
  id: string;
  targetDashboardPageId: string;
}) {
  // Get the widget to copy
  const widget = await db.first<db.DbDashboard>(
    'SELECT * FROM dashboard WHERE id = ? AND tombstone = 0',
    [id],
  );

  if (!widget) {
    throw new Error(`Widget not found: ${id}`);
  }
  const sourceOwner = await getBudgetIdForEntity({ table: 'dashboard', id });
  const targetOwner = await getBudgetIdForEntity({
    table: 'dashboard_pages',
    id: targetDashboardPageId,
  });
  if (sourceOwner !== targetOwner) {
    throw new ValidationError(
      'Dashboard widgets cannot be copied between budgets',
    );
  }

  await batchMessages(async () => {
    // Insert the widget to target dashboard
    if (isWidgetType(widget.type)) {
      await validateWidgetReferences(
        {
          type: widget.type,
          meta: widget.meta ? JSON.parse(widget.meta) : {},
        },
        sourceOwner,
      );
      const newWidget = {
        type: widget.type,
        width: widget.width,
        height: widget.height,
        meta: widget.meta ? JSON.parse(widget.meta) : {},
        dashboard_page_id: targetDashboardPageId,
      };
      await addDashboardWidget(newWidget);
    } else {
      throw new Error(`Unsupported widget type: ${widget.type}`);
    }
  });
}

async function importDashboard({
  filePath,
  dashboardPageId,
}: {
  filePath: string;
  dashboardPageId: string;
}) {
  try {
    const targetBudgetId = await getBudgetIdForEntity({
      table: 'dashboard_pages',
      id: dashboardPageId,
    });
    if (!(await fs.exists(filePath))) {
      throw new Error(`File not found at the provided path: ${filePath}`);
    }

    const content = await fs.readFile(filePath);
    const parsedContent: ExportImportDashboard = JSON.parse(content);

    exportModel.validate(parsedContent);

    const customReports = await db.all<
      Pick<db.DbCustomReport, 'id' | 'budget_id'>
    >('SELECT id, budget_id from custom_reports');
    const customReportsById = new Map(
      customReports.map(report => [report.id, report]),
    );
    for (const widget of parsedContent.widgets) {
      await validateWidgetReferences(widget, targetBudgetId, true);
    }
    for (const { meta } of parsedContent.widgets.filter(
      isExportedCustomReportWidget,
    )) {
      const existing = customReportsById.get(meta.id);
      if (existing && existing.budget_id !== targetBudgetId) {
        throw new ValidationError(
          'Cannot import a custom report owned by another budget',
        );
      }
      await validateReportReferences(
        { ...meta, budget_id: targetBudgetId },
        targetBudgetId,
      );
    }

    const existingWidgets = await db.selectWithSchema(
      'dashboard',
      'SELECT id FROM dashboard WHERE dashboard_page_id = ? AND tombstone = 0',
      [dashboardPageId],
    );

    await batchMessages(async () => {
      await Promise.all([
        // Delete all widgets
        ...existingWidgets.map(({ id }) => db.delete_('dashboard', id)),

        // Insert new widgets
        ...parsedContent.widgets.map(widget =>
          db.insertWithSchema('dashboard', {
            type: widget.type,
            width: widget.width,
            height: widget.height,
            x: widget.x,
            y: widget.y,
            dashboard_page_id: dashboardPageId,
            meta: isExportedCustomReportWidget(widget)
              ? { id: widget.meta.id }
              : widget.meta,
          }),
        ),

        // Insert new custom reports
        ...parsedContent.widgets
          .filter(isExportedCustomReportWidget)
          .filter(({ meta }) => !customReportsById.has(meta.id))
          .map(({ meta }) =>
            db.insertWithSchema(
              'custom_reports',
              reportModel.fromJS({ ...meta, budget_id: targetBudgetId }),
            ),
          ),

        // Update existing reports
        ...parsedContent.widgets
          .filter(isExportedCustomReportWidget)
          .filter(({ meta }) => customReportsById.has(meta.id))
          .map(({ meta }) =>
            db.updateWithSchema('custom_reports', {
              // Replace `undefined` values with `null`
              // (null clears the value in DB; undefined breaks the operation)
              ...Object.fromEntries(
                Object.entries(
                  reportModel.fromJS({
                    ...meta,
                    budget_id: targetBudgetId,
                  }),
                ).map(([key, value]) => [key, value ?? null]),
              ),
              tombstone: false,
            }),
          ),
      ]);
    });

    return { status: 'ok' as const };
  } catch (err: unknown) {
    if (err instanceof Error) {
      err.message = 'Error importing file: ' + err.message;
      captureException(err);
    }
    if (err instanceof SyntaxError) {
      throw new Error('Invalid JSON file.', { cause: 'json-parse-error' });
    }
    if (err instanceof ValidationError) {
      throw new Error(err.message, { cause: 'validation-error' });
    }
    throw new Error('Internal error occurred during import.', {
      cause: 'internal-error',
    });
  }
}

export type DashboardHandlers = {
  'dashboard-create': typeof createDashboardPage;
  'dashboard-delete': typeof deleteDashboardPage;
  'dashboard-rename': typeof renameDashboardPage;
  'dashboard-update': typeof updateDashboard;
  'dashboard-update-widget': typeof updateDashboardWidget;
  'dashboard-reset': typeof resetDashboard;
  'dashboard-add-widget': typeof addDashboardWidget;
  'dashboard-remove-widget': typeof removeDashboardWidget;
  'dashboard-copy-widget': typeof copyDashboardWidget;
  'dashboard-import': typeof importDashboard;
};

export const app = createApp<DashboardHandlers>();

app.method('dashboard-create', mutator(undoable(createDashboardPage)));
app.method('dashboard-delete', mutator(undoable(deleteDashboardPage)));
app.method('dashboard-rename', mutator(undoable(renameDashboardPage)));
app.method('dashboard-update', mutator(undoable(updateDashboard)));
app.method('dashboard-update-widget', mutator(undoable(updateDashboardWidget)));
app.method('dashboard-reset', mutator(undoable(resetDashboard)));
app.method('dashboard-add-widget', mutator(undoable(addDashboardWidget)));
app.method('dashboard-remove-widget', mutator(undoable(removeDashboardWidget)));
app.method('dashboard-copy-widget', mutator(undoable(copyDashboardWidget)));
app.method('dashboard-import', mutator(undoable(importDashboard)));
