import * as db from '#server/db';
import type { DbAccount, DbRule, DbSchedule } from '#server/db';

export type MigrationBlocker = {
  type: 'bank-link' | 'schedule' | 'rule';
  id: string;
  name: string;
};

function parsesJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function idValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string');
  }
  return [];
}

async function ruleReferencesAccount(
  rule: Pick<DbRule, 'conditions' | 'actions'>,
  accountId: string,
  blockingScheduleIds: Set<string> = new Set(),
): Promise<boolean> {
  const conditions =
    parsesJson<Array<Record<string, unknown>>>(rule.conditions) ?? [];
  for (const condition of conditions) {
    if (
      condition.field === 'account' &&
      idValues(condition.value).includes(accountId)
    ) {
      return true;
    }
    const queryFilter = condition.queryFilter;
    if (queryFilter && typeof queryFilter === 'object') {
      const candidate = (queryFilter as Record<string, unknown>).account;
      if (
        candidate &&
        typeof candidate === 'object' &&
        idValues((candidate as Record<string, unknown>).$oneof).includes(
          accountId,
        )
      ) {
        return true;
      }
    }
  }

  const actions =
    parsesJson<Array<Record<string, unknown>>>(rule.actions) ?? [];
  for (const action of actions) {
    if (
      action.op === 'link-schedule' &&
      typeof action.value === 'string' &&
      blockingScheduleIds.has(action.value)
    ) {
      return true;
    }
    if (action.field === 'account' && action.value === accountId) return true;
    if (action.field === 'payee' && typeof action.value === 'string') {
      const payee = await db.first<{ transfer_acct: string | null }>(
        'SELECT transfer_acct FROM payees WHERE id = ? AND tombstone = 0',
        [action.value],
      );
      if (payee?.transfer_acct === accountId) return true;
    }
  }
  return false;
}

export async function getMigrationBlockers(
  account: DbAccount,
): Promise<MigrationBlocker[]> {
  const blockers: MigrationBlocker[] = [];
  if (
    account.account_id ||
    account.bank ||
    account.account_sync_source ||
    account.bank_sync_status === 'pending' ||
    account.bank_sync_status === 'sync-requested'
  ) {
    blockers.push({ type: 'bank-link', id: account.id, name: account.name });
  }

  const schedules = await db.all<DbSchedule>(
    'SELECT * FROM schedules WHERE budget_id = ? AND tombstone = 0',
    [account.budget_id],
  );
  const activeSchedules = schedules.filter(
    schedule => schedule.active === 1 && schedule.completed === 0,
  );
  const scheduleRuleIds = new Set(schedules.map(schedule => schedule.rule));
  const rules = await db.all<DbRule>(
    'SELECT * FROM rules WHERE budget_id = ? AND tombstone = 0',
    [account.budget_id],
  );
  const rulesById = new Map(rules.map(rule => [rule.id, rule]));

  const blockingScheduleIds = new Set<string>();
  for (const schedule of activeSchedules) {
    const rule = rulesById.get(schedule.rule);
    if (rule && (await ruleReferencesAccount(rule, account.id))) {
      blockers.push({ type: 'schedule', id: schedule.id, name: schedule.name });
      blockingScheduleIds.add(schedule.id);
    }
  }
  for (const rule of rules) {
    if (scheduleRuleIds.has(rule.id)) continue;
    if (await ruleReferencesAccount(rule, account.id, blockingScheduleIds)) {
      blockers.push({ type: 'rule', id: rule.id, name: `Rule ${rule.id}` });
    }
  }
  return blockers;
}
