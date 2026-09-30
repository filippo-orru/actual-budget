import { getForeignAccounts } from '#components/reports/spreadsheets/foreignAccountFilter';

import { useAccounts } from './useAccounts';
import { useMultiCurrency } from './useMultiCurrency';

/**
 * Reports other than net worth don't convert currencies: when multi-currency
 * is enabled they exclude the transactions of foreign-currency accounts.
 *
 * `globalCurrency` is set only while the exclusion is active; pass it to the
 * report spreadsheets. `excludedAccounts` lists the accounts being excluded.
 */
export function useForeignAccountExclusion() {
  const { isEnabled, globalCurrency } = useMultiCurrency();
  const { data: accounts = [] } = useAccounts();

  const activeCurrency = isEnabled ? globalCurrency : undefined;
  const excludedAccounts = getForeignAccounts(accounts, activeCurrency);

  return {
    globalCurrency: activeCurrency,
    excludedAccounts,
    excludedAccountIds: excludedAccounts.map(account => account.id),
  };
}
