import type { ReactNode } from 'react';

import { initServer } from '@actual-app/core/platform/client/connection';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { CurrencySettings } from './Currency';
import { ExperimentalFeatures, MultiCurrencyToggle } from './Experimental';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type Status = {
  isCurrencyActive: boolean;
  globalCurrency: string;
  unassignedAccounts: { id: string; name: string }[];
  crossCurrencyTransfers: {
    transactionId: string;
    date: string;
    accountName: string;
    otherAccountName: string;
  }[];
};

const emptyStatus: Status = {
  isCurrencyActive: true,
  globalCurrency: 'USD',
  unassignedAccounts: [],
  crossCurrencyTransfers: [],
};

function renderWith(
  ui: ReactNode,
  prefs: Record<string, string>,
  handlers: Record<string, () => unknown>,
) {
  initServer(handlers);
  const store = configureTestAppStore({ queryClient: createTestQueryClient() });
  store.dispatch(mergeSyncedPrefs(prefs));
  return render(
    <TestProviders store={store} queryClient={createTestQueryClient()}>
      {ui}
    </TestProviders>,
  );
}

const currencyPrefs = { 'flags.currency': 'true', defaultCurrencyCode: 'USD' };

describe('MultiCurrencyToggle', () => {
  it('is hidden in the experimental features while the currency flag is off', async () => {
    renderWith(<ExperimentalFeatures />, {}, {});
    await userEvent.click(screen.getByText(/I understand the risks/));
    expect(screen.queryByText('Multi-currency accounts')).toBeNull();
  });

  it('is shown in the experimental features when the currency flag is on', async () => {
    renderWith(<ExperimentalFeatures />, currencyPrefs, {
      'multi-currency-status': () => emptyStatus,
    });
    await userEvent.click(screen.getByText(/I understand the risks/));
    expect(screen.getByText('Multi-currency accounts')).toBeTruthy();
  });

  it('is disabled and lists unassigned off-budget accounts', async () => {
    renderWith(<MultiCurrencyToggle />, currencyPrefs, {
      'multi-currency-status': () => ({
        ...emptyStatus,
        unassignedAccounts: [
          { id: 'a', name: 'Broker' },
          { id: 'b', name: 'Savings' },
        ],
      }),
    });

    await screen.findByText(/Broker, Savings/);
    expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Assign USD to 2 accounts' }),
    ).toBeTruthy();
  });

  it('is disabled and lists cross-currency transfers', async () => {
    renderWith(<MultiCurrencyToggle />, currencyPrefs, {
      'multi-currency-status': () => ({
        ...emptyStatus,
        crossCurrencyTransfers: [
          {
            transactionId: 't1',
            date: '2026-02-03',
            accountName: 'Broker',
            otherAccountName: 'Checking',
          },
        ],
      }),
    });

    await screen.findByText(/2026-02-03: Broker → Checking/);
    expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true);
  });

  it('enables after the default currency is assigned', async () => {
    let assigned = false;
    const assign = vi.fn(() => {
      assigned = true;
      return { count: 1 };
    });
    renderWith(<MultiCurrencyToggle />, currencyPrefs, {
      'multi-currency-status': () =>
        assigned
          ? emptyStatus
          : {
              ...emptyStatus,
              unassignedAccounts: [{ id: 'a', name: 'Broker' }],
            },
      'multi-currency-assign-default': assign,
    });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Assign USD to 1 accounts' }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(false),
    );
  });

  it('can always be turned off', async () => {
    renderWith(
      <MultiCurrencyToggle />,
      { ...currencyPrefs, 'flags.multiCurrency': 'true' },
      {
        'multi-currency-status': () => ({
          ...emptyStatus,
          unassignedAccounts: [{ id: 'a', name: 'Broker' }],
        }),
      },
    );
    await screen.findByRole('checkbox');
    expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(false);
  });
});

describe('Default currency lock', () => {
  it('disables the select and shows a hint while multiCurrency is on', () => {
    renderWith(
      <CurrencySettings />,
      { ...currencyPrefs, 'flags.multiCurrency': 'true' },
      {},
    );
    expect(
      screen.getByText(
        'Disable multi-currency to change the default currency.',
      ),
    ).toBeTruthy();
  });

  it('does not show the hint when multiCurrency is off', () => {
    renderWith(<CurrencySettings />, currencyPrefs, {});
    expect(
      screen.queryByText(
        'Disable multi-currency to change the default currency.',
      ),
    ).toBeNull();
  });
});
