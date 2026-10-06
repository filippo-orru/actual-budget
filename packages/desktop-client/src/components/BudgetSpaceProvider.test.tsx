import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import {
  clearServer,
  initServer,
  serverPush,
} from '@actual-app/core/platform/client/connection';
import type { BudgetSpaceEntity } from '@actual-app/core/types/models';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleGlobalEvents } from '#global-events';
import { useBudgetSpace } from '#hooks/useBudgetSpace';
import { configureTestAppStore, createTestQueryClient } from '#mocks';
import { mergeLocalPrefs } from '#prefs/prefsSlice';

import { BudgetSpaceProvider } from './BudgetSpaceProvider';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

function budgetSpace(id: string): BudgetSpaceEntity {
  return {
    id,
    name: id,
    currency_code: 'USD',
    budget_type: 'envelope',
    sort_order: 0,
    tombstone: false,
  };
}

function SelectedBudget() {
  const selectedBudget = useBudgetSpace();
  return <div data-testid="selected-budget">{selectedBudget.id}</div>;
}

function renderBudgetSpaceProvider(
  fileId = 'file-1',
  queryClient = createTestQueryClient(),
  initialEntry = '/settings',
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );

  const result = render(
    <BudgetSpaceProvider fileId={fileId}>
      <SelectedBudget />
    </BudgetSpaceProvider>,
    { wrapper },
  );
  return { ...result, queryClient };
}

function listenForBudgetEvents(queryClient: QueryClient) {
  const store = configureTestAppStore({ queryClient });
  store.dispatch(mergeLocalPrefs({ id: 'file-1' }));
  return handleGlobalEvents(store, queryClient);
}

describe('BudgetSpaceProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(vi.fn());
    initServer({
      'budget-spaces/get': async () => [budgetSpace('default')],
    });
  });

  afterEach(async () => {
    await clearServer();
    vi.restoreAllMocks();
  });

  it('waits for the list query before mounting financial UI', async () => {
    let resolveBudgetSpaces!: (spaces: BudgetSpaceEntity[]) => void;
    const pendingBudgetSpaces = new Promise<BudgetSpaceEntity[]>(resolve => {
      resolveBudgetSpaces = resolve;
    });
    initServer({
      'budget-spaces/get': () => pendingBudgetSpaces,
    });

    renderBudgetSpaceProvider();

    expect(screen.queryByTestId('selected-budget')).not.toBeInTheDocument();
    resolveBudgetSpaces([budgetSpace('default')]);
    expect(await screen.findByTestId('selected-budget')).toHaveTextContent(
      'default',
    );
  });

  it('shows the query error instead of mounting financial UI', async () => {
    initServer({
      'budget-spaces/get': async () => {
        throw new Error('Budget list request failed');
      },
    });

    renderBudgetSpaceProvider();

    expect(
      await screen.findByText('Budget list request failed'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('selected-budget')).not.toBeInTheDocument();
  });

  it('provides the sole active budget', async () => {
    renderBudgetSpaceProvider();

    expect(await screen.findByTestId('selected-budget')).toHaveTextContent(
      'default',
    );
  });

  it('fails clearly when no active budget exists', async () => {
    initServer({
      'budget-spaces/get': async () => [
        {
          ...budgetSpace('deleted'),
          tombstone: true,
        },
      ],
    });

    renderBudgetSpaceProvider();

    expect(
      await screen.findByText('No active budget was found in this file.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('selected-budget')).not.toBeInTheDocument();
  });

  it('uses the explicit budget from the URL ahead of the saved default', async () => {
    initServer({
      'budget-spaces/get': async () => [
        budgetSpace('default'),
        budgetSpace('other'),
      ],
    });

    renderBudgetSpaceProvider(
      'file-1',
      createTestQueryClient(),
      '/spaces/other/budget',
    );

    expect(await screen.findByTestId('selected-budget')).toHaveTextContent(
      'other',
    );
  });

  it('does not fall back when an explicit URL references an unknown budget', async () => {
    renderBudgetSpaceProvider(
      'file-1',
      createTestQueryClient(),
      '/spaces/missing/budget',
    );

    expect(await screen.findByText('Budget not found')).toBeInTheDocument();
    expect(screen.queryByTestId('selected-budget')).not.toBeInTheDocument();
  });

  it('falls back to the first active budget when no default exists', async () => {
    initServer({
      'budget-spaces/get': async () => [budgetSpace('one'), budgetSpace('two')],
    });

    renderBudgetSpaceProvider();

    expect(await screen.findByTestId('selected-budget')).toHaveTextContent(
      'one',
    );
  });

  it('loads a new selection when the opened file changes', async () => {
    let requestCount = 0;
    initServer({
      'budget-spaces/get': async () => {
        requestCount += 1;
        return requestCount === 1
          ? [budgetSpace('first-file-budget')]
          : [budgetSpace('second-file-budget')];
      },
    });

    const { rerender } = renderBudgetSpaceProvider('file-1');
    expect(await screen.findByTestId('selected-budget')).toHaveTextContent(
      'first-file-budget',
    );

    rerender(
      <BudgetSpaceProvider fileId="file-2">
        <SelectedBudget />
      </BudgetSpaceProvider>,
    );
    expect(screen.queryByTestId('selected-budget')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId('selected-budget')).toHaveTextContent(
        'second-file-budget',
      ),
    );
    expect(requestCount).toBe(2);
  });

  it.each(['applied', 'success'] as const)(
    'rechecks sole-budget selection after a %s sync event for budgets',
    async type => {
      let spaces = [budgetSpace('default')];
      let requestCount = 0;
      initServer({
        'budget-spaces/get': async () => {
          requestCount += 1;
          return spaces;
        },
      });

      const queryClient = createTestQueryClient();
      const unlisten = listenForBudgetEvents(queryClient);
      renderBudgetSpaceProvider('file-1', queryClient);
      expect(await screen.findByTestId('selected-budget')).toHaveTextContent(
        'default',
      );
      expect(requestCount).toBe(1);

      spaces = [budgetSpace('default'), budgetSpace('synced-budget')];
      await act(async () => {
        serverPush('sync-event', { type, tables: ['budgets'] });
        await waitFor(() => expect(requestCount).toBe(2));
      });

      expect(screen.getByTestId('selected-budget')).toHaveTextContent(
        'default',
      );
      expect(requestCount).toBe(2);
      unlisten();
    },
  );

  it('rechecks sole-budget selection after undo changes budgets', async () => {
    let spaces = [budgetSpace('default')];
    let requestCount = 0;
    initServer({
      'budget-spaces/get': async () => {
        requestCount += 1;
        return spaces;
      },
    });

    const queryClient = createTestQueryClient();
    const unlisten = listenForBudgetEvents(queryClient);
    renderBudgetSpaceProvider('file-1', queryClient);
    expect(await screen.findByTestId('selected-budget')).toHaveTextContent(
      'default',
    );

    spaces = [budgetSpace('default'), budgetSpace('undone-budget')];
    await act(async () => {
      serverPush('undo-event', {
        tables: ['budgets'],
        undoTag: 'unmatched-undo-tag',
      });
      await waitFor(() => expect(requestCount).toBe(2));
    });

    expect(screen.getByTestId('selected-budget')).toHaveTextContent('default');
    expect(requestCount).toBe(2);
    unlisten();
  });
});
