import type { ReactNode } from 'react';

import { initServer } from '@actual-app/core/platform/client/connection';
import { render, screen } from '@testing-library/react';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { MultiCurrencyToggle } from './Experimental';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

function renderWith(
  ui: ReactNode,
  prefs: Record<string, string>,
  handlers: Record<string, () => unknown> = {},
) {
  initServer(handlers);
  const queryClient = createTestQueryClient();
  const store = configureTestAppStore({ queryClient });
  store.dispatch(mergeSyncedPrefs(prefs));
  return render(
    <TestProviders store={store} queryClient={queryClient}>
      {ui}
    </TestProviders>,
  );
}

describe('MultiCurrencyToggle', () => {
  it.each(['false', 'true'])(
    'has no account-currency prerequisites when enabled state is %s',
    multiCurrency => {
      const statusHandler = vi.fn();
      const assignmentHandler = vi.fn();
      renderWith(
        <MultiCurrencyToggle />,
        { 'flags.multiCurrency': multiCurrency },
        {
          'multi-currency-status': statusHandler,
          'multi-currency-assign-default': assignmentHandler,
        },
      );

      expect(
        screen.getByRole('checkbox', { name: 'Multi-currency accounts' }),
      ).toBeEnabled();
      expect(statusHandler).not.toHaveBeenCalled();
      expect(assignmentHandler).not.toHaveBeenCalled();
    },
  );
});
