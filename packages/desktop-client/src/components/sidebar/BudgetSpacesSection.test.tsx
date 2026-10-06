import { MemoryRouter } from 'react-router';

import type { BudgetSpaceEntity } from '@actual-app/core/types/models';
import { render, screen } from '@testing-library/react';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { useBudgetOverview } from '#hooks/useBudgetOverview';
import { BudgetSpaceContext } from '#hooks/useBudgetSpace';
import { useCurrencyRates } from '#hooks/useExchangeRates';
import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs, setPrefs } from '#prefs/prefsSlice';

import { BudgetSpacesSection } from './BudgetSpacesSection';

vi.mock('#hooks/useBudgetOverview', () => ({
  useBudgetOverview: vi.fn(),
}));
vi.mock('#hooks/useExchangeRates', () => ({
  useCurrencyRates: vi.fn(),
}));
vi.mock('#util/isTouchDevice', () => ({
  isTouchDevice: () => false,
}));

function budget(
  id: string,
  name: string,
  currencyCode: string,
): BudgetSpaceEntity {
  return {
    id,
    name,
    currency_code: currencyCode,
    budget_type: 'envelope',
    sort_order: 0,
    tombstone: false,
  };
}

describe('BudgetSpacesSection', () => {
  it('shows every budget total and links to the canonical budget routes', () => {
    const budgets = [
      budget('default', 'Home', 'EUR'),
      budget('travel', 'Travel', 'USD'),
      budget('empty', 'Empty', 'EUR'),
      budget('none', 'Unspecified', ''),
    ];
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      budgetSpaceQueries.list('file-1').queryKey,
      budgets,
    );
    const store = configureTestAppStore({ queryClient });
    store.dispatch(
      setPrefs({ local: { id: 'file-1' }, global: {}, synced: {} }),
    );
    store.dispatch(
      mergeSyncedPrefs({
        'flags.multiCurrency': 'true',
        'flags.currency': 'true',
      }),
    );
    vi.mocked(useBudgetOverview).mockReturnValue({
      rows: [
        { budgetId: 'default', balance: 18500 },
        { budgetId: 'travel', balance: 10000 },
        { budgetId: 'none', balance: 500 },
      ],
      isLoading: false,
      error: null,
    });
    vi.mocked(useCurrencyRates).mockReturnValue({
      rates: { USD: 1.1 },
      offlineCurrencies: [],
      failedCurrencies: [],
      isLoading: false,
    });

    render(
      <TestProviders store={store} queryClient={queryClient}>
        <BudgetSpaceContext.Provider value={budgets[0]}>
          <MemoryRouter initialEntries={['/budgets/default/budget']}>
            <BudgetSpacesSection />
          </MemoryRouter>
        </BudgetSpaceContext.Provider>
      </TestProviders>,
    );

    expect(screen.getByText('Spaces')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-budget-spaces')).toHaveTextContent(
      '300',
    );
    expect(
      screen.queryByRole('button', { name: 'Create budget space' }),
    ).not.toBeInTheDocument();

    const selected = screen.getByRole('link', { name: /Home/ });
    const travel = screen.getByRole('link', { name: /Travel/ });
    const empty = screen.getByRole('link', { name: /Empty/ });
    const unspecified = screen.getByRole('link', { name: /Unspecified/ });

    expect(selected).toHaveAttribute('href', '/budgets/default/settings');
    expect(selected).toHaveTextContent('Home');
    expect(selected).toHaveTextContent('€');
    expect(selected).toHaveTextContent('185');
    expect(travel).toHaveAttribute('href', '/budgets/travel/budget');
    expect(travel).toHaveTextContent('Travel');
    expect(travel).toHaveTextContent('≈');
    expect(empty).toHaveTextContent('Empty');
    expect(empty).toHaveTextContent('€');
    expect(empty).toHaveTextContent('0');
    expect(unspecified).toHaveTextContent('5.00');
    expect(unspecified).not.toHaveTextContent('None');
  });
});
