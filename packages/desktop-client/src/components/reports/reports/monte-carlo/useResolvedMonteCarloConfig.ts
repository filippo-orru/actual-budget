import { useMemo } from 'react';

import type { MonteCarloConfig } from '#components/reports/reports/monte-carlo/monteCarloSimulation';
import { useAccountBalances } from '#hooks/useAccountBalances';
import { useForeignAccountExclusion } from '#hooks/useForeignAccountExclusion';

/**
 * Resolves account-linked pots to their live balances: a linked pot takes
 * the account's current balance, falling back to its stored starting
 * balance until the live value arrives. Shared by the report page and the
 * dashboard card so both simulate the same portfolio.
 *
 * When multi-currency is on, pots linked to a foreign-currency account are
 * excluded (they start at 0) because the simulation doesn't convert
 * currencies.
 */
export function useResolvedMonteCarloConfig(
  config: MonteCarloConfig,
): MonteCarloConfig {
  const { excludedAccountIds } = useForeignAccountExclusion();
  const accountBalances = useAccountBalances(
    config.pots
      .map(pot => pot.accountId)
      .filter(
        (id): id is string => id != null && !excludedAccountIds.includes(id),
      ),
  );

  // Memoized by hand: this plain .ts file sits outside the React
  // Compiler's include (.tsx only), and the compiled consumers key their
  // auto-memoized simulation runs on this object's identity - a fresh
  // object every render would re-simulate on every unrelated re-render
  const excludedKey = excludedAccountIds.join(',');
  return useMemo(
    () => ({
      ...config,
      pots: config.pots.map(pot => {
        if (
          pot.accountId != null &&
          excludedKey.split(',').includes(pot.accountId)
        ) {
          return { ...pot, startingBalance: 0 };
        }
        const balance =
          pot.accountId != null ? accountBalances[pot.accountId] : null;
        return balance != null
          ? { ...pot, startingBalance: Math.max(0, balance) }
          : pot;
      }),
    }),
    [config, accountBalances, excludedKey],
  );
}
