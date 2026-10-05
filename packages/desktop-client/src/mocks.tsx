import React from 'react';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { BudgetSpaceContext } from './hooks/useBudgetSpace';
import { configureAppStore } from './redux/store';
import type { AppStore } from './redux/store';

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

export function configureTestAppStore(
  ...args: Parameters<typeof configureAppStore>
) {
  return configureAppStore(...args);
}

let testQueryClient = createTestQueryClient();
let testStore = configureTestAppStore({
  queryClient: testQueryClient,
});

export function resetTestProviders() {
  testQueryClient = createTestQueryClient();
  testStore = configureTestAppStore({ queryClient: testQueryClient });
}

export function createTestAppStore() {
  return configureAppStore({
    queryClient: testQueryClient,
  });
}

export function TestProviders({
  children,
  queryClient,
  store,
}: {
  queryClient?: QueryClient;
  store?: AppStore;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient ?? testQueryClient}>
      <Provider store={store ?? testStore}>
        <BudgetSpaceContext.Provider
          value={{
            id: 'default',
            name: '',
            currency_code: '',
            budget_type: 'envelope',
            sort_order: 0,
            tombstone: false,
          }}
        >
          {children}
        </BudgetSpaceContext.Provider>
      </Provider>
    </QueryClientProvider>
  );
}
