import { v4 as uuidv4 } from 'uuid';

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
import { undoable } from '#server/undo';
import { q } from '#shared/query';
import type { CustomReportData, CustomReportEntity } from '#types/models';

export const reportModel = {
  validate(
    report: Omit<CustomReportEntity, 'tombstone'>,
    { update }: { update?: boolean } = {},
  ) {
    requiredFields('Report', report, ['conditionsOp'], update);

    if (!update || 'conditionsOp' in report) {
      if (!['and', 'or'].includes(report.conditionsOp)) {
        throw new ValidationError(
          'Invalid filter conditionsOp: ' + report.conditionsOp,
        );
      }
    }

    return report;
  },

  toJS(row: CustomReportData): CustomReportEntity {
    return {
      id: row.id,
      budget_id: row.budget_id,
      name: row.name ?? '',
      startDate: row.start_date,
      endDate: row.end_date,
      isDateStatic: row.date_static === 1,
      dateRange: row.date_range,
      mode: row.mode,
      groupBy: row.group_by,
      sortBy: row.sort_by,
      interval: row.interval,
      balanceType: row.balance_type,
      showEmpty: row.show_empty === 1,
      showOffBudget: row.show_offbudget === 1,
      showHiddenCategories: row.show_hidden === 1,
      showUncategorized: row.show_uncategorized === 1,
      trimIntervals: row.trim_intervals === 1,
      showTrendLines: row.show_trend_lines === 1,
      includeCurrentInterval: row.include_current === 1,
      graphType: row.graph_type,
      conditions: row.conditions ?? [],
      conditionsOp: row.conditions_op ?? 'and',
      metadata: row.metadata,
    };
  },

  fromJS(report: CustomReportEntity): CustomReportData {
    return {
      id: report.id,
      budget_id: report.budget_id,
      name: report.name,
      start_date: report.startDate,
      end_date: report.endDate,
      date_static: report.isDateStatic ? 1 : 0,
      date_range: report.dateRange,
      mode: report.mode,
      group_by: report.groupBy,
      sort_by: report.sortBy ?? 'desc',
      interval: report.interval,
      balance_type: report.balanceType,
      show_empty: report.showEmpty ? 1 : 0,
      show_offbudget: report.showOffBudget ? 1 : 0,
      show_hidden: report.showHiddenCategories ? 1 : 0,
      show_uncategorized: report.showUncategorized ? 1 : 0,
      trim_intervals: report.trimIntervals ? 1 : 0,
      show_trend_lines: report.showTrendLines ? 1 : 0,
      include_current: report.includeCurrentInterval ? 1 : 0,
      graph_type: report.graphType,
      conditions: report.conditions,
      conditions_op: report.conditionsOp,
    };
  },
};

// Sort reports by alphabetical order
function sort(reports: CustomReportEntity[]) {
  return reports.sort((a, b) =>
    a.name && b.name
      ? a.name.trim().localeCompare(b.name.trim(), undefined, {
          ignorePunctuation: true,
        })
      : 0,
  );
}

async function getReports({ budgetId }: { budgetId: string }) {
  await validateBudgetExists(budgetId);
  // Use aql because it auto deserialized json columns e.g. conditions
  const { data }: { data: CustomReportData[] } = await aqlQuery(
    q('custom_reports').filter({ budget_id: budgetId }).select('*'),
  );
  return sort(data.map(r => reportModel.toJS(r)));
}

async function reportNameExists(
  budgetId: string,
  name: string,
  reportId: string,
  newItem: boolean,
) {
  const idForName = await db.first<Pick<db.DbCustomReport, 'id'>>(
    'SELECT id from custom_reports WHERE tombstone = 0 AND budget_id = ? AND name = ?',
    [budgetId, name],
  );

  //no existing name found
  if (idForName === null) {
    return false;
  }

  //for update/rename
  if (!newItem) {
    /*
    -if the found item is the same as the existing item
    then no name change was made.
    -if they are not the same then there is another
    item with that name already.
    */
    return idForName.id !== reportId;
  }

  //default return: item was found but does not match current name
  return true;
}

export async function validateReportReferences(
  report: CustomReportEntity,
  budgetId: string,
) {
  const references: Array<{
    table: 'accounts' | 'categories' | 'category_groups' | 'schedules';
    id: string;
  }> = [];
  for (const condition of report.conditions ?? []) {
    const table =
      condition.field === 'account'
        ? 'accounts'
        : condition.field === 'category'
          ? 'categories'
          : condition.field === 'category_group'
            ? 'category_groups'
            : null;
    if (!table) {
      continue;
    }
    const values =
      condition.op === 'oneOf' || condition.op === 'notOneOf'
        ? condition.value
        : [condition.value];
    for (const id of values ?? []) {
      if (typeof id === 'string' && id.length > 0) {
        references.push({ table, id });
      }
    }
  }
  if (references.length > 0) {
    await assertBudgetOwner(budgetId, references);
  }
}

async function createReport(report: CustomReportEntity) {
  if (!report.budget_id) {
    throw new ValidationError('Budget ID is required to create a report');
  }
  await validateBudgetExists(report.budget_id);
  await validateReportReferences(report, report.budget_id);
  const reportId = uuidv4();
  const item: CustomReportEntity = {
    ...report,
    id: reportId,
  };
  if (!item.name) {
    throw new Error('Report name is required');
  }

  const nameExists = await reportNameExists(
    item.budget_id,
    item.name,
    item.id ?? '',
    true,
  );
  if (nameExists) {
    throw new Error('There is already a report named ' + item.name);
  }

  // Create the report here based on the info
  await db.insertWithSchema('custom_reports', reportModel.fromJS(item));

  return reportId;
}

async function updateReport(item: CustomReportEntity) {
  if (!item.name) {
    throw new Error('Report name is required');
  }

  if (!item.id) {
    throw new Error('Report recall error');
  }

  const budgetId = await getBudgetIdForEntity({
    table: 'custom_reports',
    id: item.id,
  });
  if (item.budget_id !== budgetId) {
    throw new ValidationError('Report ownership cannot be changed');
  }
  await validateReportReferences(item, budgetId);
  const nameExists = await reportNameExists(
    budgetId,
    item.name,
    item.id,
    false,
  );
  if (nameExists) {
    throw new Error('There is already a report named ' + item.name);
  }

  await db.updateWithSchema('custom_reports', reportModel.fromJS(item));
}

async function deleteReport(id: CustomReportEntity['id']) {
  await getBudgetIdForEntity({ table: 'custom_reports', id });
  await db.delete_('custom_reports', id);
}

export type ReportsHandlers = {
  'report/get': typeof getReports;
  'report/create': typeof createReport;
  'report/update': typeof updateReport;
  'report/delete': typeof deleteReport;
};

// Expose functions to the client
export const app = createApp<ReportsHandlers>();

app.method('report/get', getReports);
app.method('report/create', mutator(undoable(createReport)));
app.method('report/update', mutator(undoable(updateReport)));
app.method('report/delete', mutator(undoable(deleteReport)));
