import { useCallback, useEffect, useState } from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { aqlQuery } from '#queries/aqlQuery';

export type CleanupGroup = { id: string; name: string };

export function useCleanupGroups() {
  const budgetId = useBudgetSpaceId();
  const [groups, setGroups] = useState<CleanupGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const result = await aqlQuery(
      q('cleanup_groups')
        .filter({ budget_id: budgetId, tombstone: false })
        .select(['id', 'name']),
    );
    const rows = Array.isArray(result.data) ? result.data : [];
    setGroups(
      rows.flatMap(row =>
        row && typeof row.id === 'string' && typeof row.name === 'string'
          ? [{ id: row.id, name: row.name }]
          : [],
      ),
    );
    setLoading(false);
  }, [budgetId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function createGroup(name: string) {
    const { id } = await send('budget/create-cleanup-group', {
      name,
      budgetId,
    });
    await reload();
    return id;
  }

  return { groups, loading, createGroup };
}
