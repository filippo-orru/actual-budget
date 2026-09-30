import { generateAccount } from '@actual-app/core/mocks';
import { initServer } from '@actual-app/core/platform/client/connection';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { EditAccountCurrencyModal } from './EditAccountCurrencyModal';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

// Only the network call is replaced: the mutation hook itself is real.
const { setCurrencyCall } = vi.hoisted(() => ({
  setCurrencyCall: vi.fn(),
}));
vi.mock('#accounts', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useSetAccountCurrencyMutation: () =>
      useMutation({
        mutationFn: async (payload: { id: string; currency: string }) => {
          await setCurrencyCall(payload);
        },
      }),
  };
});

type Conflict = {
  transactionId: string;
  date: string;
  accountName: string;
  otherAccountName: string;
};

function setup({
  currency = null,
  conflicts = [],
}: {
  currency?: string | null;
  conflicts?: Conflict[];
} = {}) {
  const setCurrency = setCurrencyCall;
  setCurrency.mockReset();
  initServer({
    'account-currency-conflicts': () =>
      Promise.resolve(
        conflicts.map(c => ({ ...c, accountId: '', otherAccountId: '' })),
      ),
  });
  const store = configureTestAppStore({ queryClient: createTestQueryClient() });
  store.dispatch(
    mergeSyncedPrefs({ 'flags.currency': 'true', defaultCurrencyCode: 'USD' }),
  );
  const account = { ...generateAccount('Broker', false, true), currency };
  render(
    <TestProviders store={store}>
      <EditAccountCurrencyModal account={account} />
    </TestProviders>,
  );
  return { setCurrency, account };
}

describe('EditAccountCurrencyModal', () => {
  it('unassigned: shows warnings and stores the global currency when unchecked', async () => {
    const { setCurrency, account } = setup();

    expect(screen.getByText('Broker')).toBeTruthy();
    expect(
      screen.getByText(/Existing transactions in this account will not be/),
    ).toBeTruthy();
    expect(
      screen.getByText('The currency cannot be changed once it is set.'),
    ).toBeTruthy();

    const saveButton = screen.getByRole('button', { name: 'Set currency' });
    const user = userEvent.setup();
    await user.click(saveButton);
    await waitFor(() =>
      expect(setCurrency).toHaveBeenCalledWith({
        id: account.id,
        currency: 'USD',
      }),
    );
  });

  it('assigned: is read-only and has no save button', () => {
    setup({ currency: 'EUR' });

    expect(screen.getByText(/EUR/)).toBeTruthy();
    expect(
      screen.getByText(
        'The currency of this account cannot be changed once set.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set currency' })).toBeNull();
  });

  it('blocked: disables saving and explains why', async () => {
    setup({
      conflicts: [
        {
          transactionId: 't1',
          date: '2026-01-01',
          accountName: 'Broker',
          otherAccountName: 'Checking',
        },
      ],
    });

    await screen.findByText(/transfers with accounts in a different/);
    expect(screen.getByText(/Broker → Checking/)).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Set currency' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
});
