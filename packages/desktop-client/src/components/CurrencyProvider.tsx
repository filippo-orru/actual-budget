import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const CurrencyContext = createContext<string | null>(null);

type CurrencyProviderProps = {
  /**
   * ISO code of the currency to format amounts in. `null` keeps the default
   * the owning budget's currency.
   */
  currencyCode: string | null;
  children: ReactNode;
};

export function CurrencyProvider({
  currencyCode,
  children,
}: CurrencyProviderProps) {
  return <CurrencyContext value={currencyCode}>{children}</CurrencyContext>;
}

export function useCurrencyOverride(): string | null {
  return useContext(CurrencyContext);
}
