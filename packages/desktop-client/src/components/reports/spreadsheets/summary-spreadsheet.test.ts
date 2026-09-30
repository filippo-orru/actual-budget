import {
  clearServer,
  initServer,
} from '@actual-app/core/platform/client/connection';
import { enUS } from 'date-fns/locale';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { foreignAccountFilter } from './foreignAccountFilter';
import { summarySpreadsheet } from './summary-spreadsheet';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

afterEach(async () => {
  await clearServer();
});

async function runSummary(globalCurrency?: string) {
  const queries: Array<{ filterExpressions: readonly unknown[] }> = [];
  initServer({
    'make-filters-from-conditions': async () => ({ filters: [] }),
    query: async query => {
      queries.push(query);
      return {
        data: [{ date: '2026-01-05', amount: -5000 }],
        dependencies: [],
      };
    },
  });

  await summarySpreadsheet(
    '2026-01',
    '2026-01',
    [],
    'and',
    { type: 'sum' },
    enUS,
    globalCurrency,
  )(undefined as never, () => undefined);

  return queries;
}

describe('summary report foreign-currency exclusion', () => {
  it('excludes foreign-currency accounts when multi-currency is on', async () => {
    const queries = await runSummary('USD');

    expect(queries).toHaveLength(1);
    expect(queries[0].filterExpressions).toContainEqual(
      foreignAccountFilter('USD'),
    );
  });

  it('does not filter accounts when multi-currency is off', async () => {
    const queries = await runSummary(undefined);

    expect(queries).toHaveLength(1);
    expect(JSON.stringify(queries[0].filterExpressions)).not.toContain(
      'account.currency',
    );
  });
});
