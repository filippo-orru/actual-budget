import type { ReactNode } from 'react';

import { renderHook } from '@testing-library/react';

import { CurrencyProvider } from '#components/CurrencyProvider';
import { BudgetSpaceContext } from '#hooks/useBudgetSpace';
import {
  configureTestAppStore,
  createTestQueryClient,
  TestProviders,
} from '#mocks';
import { mergeSyncedPrefs } from '#prefs/prefsSlice';

import { useFormat } from './useFormat';

function renderFormat(
  currencyCode: string | undefined,
  budgetCurrencyCode?: string,
) {
  const store = configureTestAppStore({ queryClient: createTestQueryClient() });
  store.dispatch(
    mergeSyncedPrefs({
      numberFormat: 'comma-dot',
      hideFraction: 'false',
    }),
  );

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <TestProviders store={store}>
        <BudgetSpaceContext.Provider
          value={
            budgetCurrencyCode === undefined
              ? null
              : {
                  id: 'budget-test',
                  name: 'Test budget',
                  currency_code: budgetCurrencyCode,
                  budget_type: 'envelope',
                  sort_order: 0,
                  tombstone: false,
                }
          }
        >
          {currencyCode === undefined ? (
            children
          ) : (
            <CurrencyProvider currencyCode={currencyCode || null}>
              {children}
            </CurrencyProvider>
          )}
        </BudgetSpaceContext.Provider>
      </TestProviders>
    );
  }

  return renderHook(() => useFormat(), { wrapper }).result.current;
}

// Strips the directional formatting marks added around the symbol
function plain(value: string) {
  return value.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

describe('useFormat', () => {
  it('uses None currency formatting without a financial budget context', () => {
    const format = renderFormat(undefined);

    expect(plain(format(123456, 'financial'))).toBe('1,234.56');
    expect(format.forEdit(123456)).toBe('1,234.56');
    expect(format.fromEdit('12.34')).toBe(1234);
  });

  it('uses None currency when the override provider holds null', () => {
    const format = renderFormat('');

    expect(plain(format(123456, 'financial'))).toBe('1,234.56');
    expect(format.currency.code).toBe('');
  });

  it('uses the owning budget currency for formatting and input parsing', () => {
    const format = renderFormat(undefined, 'JPY');

    expect(plain(format(1000, 'financial'))).toBe('¥1,000');
    expect(format.forEdit(1000)).toBe('1,000');
    expect(format.fromEdit('1000')).toBe(1000);
    expect(format.currency.code).toBe('JPY');
  });

  it('formats and parses with 0 decimals inside a JPY provider', () => {
    const format = renderFormat('JPY');

    expect(plain(format(1000, 'financial'))).toBe('¥1,000');
    expect(format.forEdit(1000)).toBe('1,000');
    expect(format.fromEdit('1000')).toBe(1000);
    expect(format.currency.decimalPlaces).toBe(0);
  });

  it('formats and parses with 2 decimals inside a EUR provider', () => {
    const format = renderFormat('EUR');

    expect(plain(format(123456, 'financial'))).toContain('€');
    expect(plain(format(123456, 'financial'))).toContain('1,234.56');
    expect(format.forEdit(1234)).toBe('12.34');
    expect(format.fromEdit('12.34')).toBe(1234);
  });

  it('keeps the global formatting when the provider holds the global currency', () => {
    const format = renderFormat('USD');

    expect(plain(format(123456, 'financial'))).toBe('$1,234.56');
  });
});
