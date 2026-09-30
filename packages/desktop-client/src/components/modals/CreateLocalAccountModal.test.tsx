import { MemoryRouter } from 'react-router';

import { initServer } from '@actual-app/core/platform/client/connection';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { CreateLocalAccountModal } from './CreateLocalAccountModal';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

// Only the network call is replaced: the mutation hook itself is real.
const { createAccountCall } = vi.hoisted(() => ({
  createAccountCall: vi.fn(),
}));
vi.mock('#accounts', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useCreateAccountMutation: () =>
      useMutation({
        mutationFn: async (payload: unknown) => {
          await createAccountCall(payload);
          return 'new-id';
        },
      }),
  };
});

vi.mock('#hooks/useAccounts', () => ({
  useAccounts: () => ({ data: [] }),
}));

function setup({ currencyActive }: { currencyActive: boolean }) {
  createAccountCall.mockReset();
  initServer({});
  const store = configureTestAppStore({ queryClient: createTestQueryClient() });
  store.dispatch(
    mergeSyncedPrefs({
      'flags.currency': currencyActive ? 'true' : 'false',
      defaultCurrencyCode: 'USD',
    }),
  );
  render(
    <TestProviders store={store}>
      <MemoryRouter>
        <CreateLocalAccountModal />
      </MemoryRouter>
    </TestProviders>,
  );
  return userEvent.setup();
}

const currencyLabel = /Use a different currency than the budget default/;

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/e\.g\. Bank/), 'My account');
  await user.click(screen.getByRole('button', { name: 'Create' }));
}

describe('CreateLocalAccountModal currency', () => {
  it('shows the currency field only for off-budget accounts', async () => {
    const user = setup({ currencyActive: true });
    expect(screen.queryByText(currencyLabel)).toBeNull();

    await user.click(screen.getByLabelText('Off budget'));
    expect(screen.getByText(currencyLabel)).toBeTruthy();
  });

  it('hides the currency field when the feature is inactive', async () => {
    const user = setup({ currencyActive: false });
    await user.click(screen.getByLabelText('Off budget'));
    expect(screen.queryByText(currencyLabel)).toBeNull();
  });

  it('passes the global currency for an off-budget account', async () => {
    const user = setup({ currencyActive: true });
    await user.click(screen.getByLabelText('Off budget'));
    await fillAndSubmit(user);

    await waitFor(() =>
      expect(createAccountCall).toHaveBeenCalledWith(
        expect.objectContaining({ offBudget: true, currency: 'USD' }),
      ),
    );
  });

  it('passes null for an on-budget account', async () => {
    const user = setup({ currencyActive: true });
    await fillAndSubmit(user);

    await waitFor(() =>
      expect(createAccountCall).toHaveBeenCalledWith(
        expect.objectContaining({ offBudget: false, currency: null }),
      ),
    );
  });

  it('passes null when the feature is inactive', async () => {
    const user = setup({ currencyActive: false });
    await user.click(screen.getByLabelText('Off budget'));
    await fillAndSubmit(user);

    await waitFor(() =>
      expect(createAccountCall).toHaveBeenCalledWith(
        expect.objectContaining({ offBudget: true, currency: null }),
      ),
    );
  });
});
