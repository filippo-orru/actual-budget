import * as db from '#server/db';
import type { DbSchedule } from '#server/db';

import { GOAL_PREFIX, TEMPLATE_PREFIX } from './template-notes';

export async function resetCategoryGoalDefsWithNoTemplates(
  budgetId: string,
  categoryIds?: string[],
): Promise<void> {
  if (categoryIds?.length === 0) return;
  const categoryScope = categoryIds
    ? `AND id IN (${categoryIds.map(() => '?').join(',')})`
    : '';
  await db.run(
    `
      UPDATE categories
      SET goal_def = NULL
      WHERE budget_id = ?
        AND id NOT IN (SELECT n.id
                       FROM notes n
                       WHERE lower(note) LIKE '%${TEMPLATE_PREFIX}%'
                          OR lower(note) LIKE '%${GOAL_PREFIX}%')
        AND COALESCE(JSON_EXTRACT(template_settings, '$.source'), 'notes') <> 'ui'
        ${categoryScope}
    `,
    [budgetId, ...(categoryIds ?? [])],
  );
}

export type CategoryWithTemplateNote = {
  id: string;
  name: string;
  note: string;
};

export async function getCategoriesWithTemplateNotes(
  budgetId: string,
  categoryIds?: string[],
): Promise<CategoryWithTemplateNote[]> {
  if (categoryIds?.length === 0) return [];
  const categoryScope = categoryIds
    ? `AND c.id IN (${categoryIds.map(() => '?').join(',')})`
    : '';
  return await db.all<
    Pick<db.DbCategory, 'id' | 'name'> & Pick<db.DbNote, 'note'>
  >(
    `
      SELECT c.id AS id, c.name as name, n.note AS note
      FROM notes n
             JOIN categories c ON n.id = c.id
      WHERE c.budget_id = ?
        AND c.id = n.id
        AND c.tombstone = 0
        AND COALESCE(JSON_EXTRACT(c.template_settings, '$.source'), 'notes') <> 'ui'
        AND (lower(note) LIKE '%${TEMPLATE_PREFIX}%'
        OR lower(note) LIKE '%${GOAL_PREFIX}%')
        ${categoryScope}
    `,
    [budgetId, ...(categoryIds ?? [])],
  );
}

export async function getActiveSchedules(budgetId: string) {
  return await db.all<
    Pick<
      DbSchedule,
      | 'id'
      | 'rule'
      | 'active'
      | 'completed'
      | 'posts_transaction'
      | 'tombstone'
      | 'name'
    >
  >(
    'SELECT id, rule, active, completed, posts_transaction, tombstone, name from schedules WHERE budget_id = ? AND name NOT NULL AND tombstone = 0',
    [budgetId],
  );
}
