import { useFeatureFlag } from './useFeatureFlag';
import { useSyncedPref } from './useSyncedPref';

/**
 * The currency feature is active when the `currency` experimental flag is on
 * and a default (global) currency is selected.
 */
export function useCurrencyFeature() {
  const isCurrencyFlagOn = useFeatureFlag('currency');
  const [defaultCurrencyCode] = useSyncedPref('defaultCurrencyCode');
  const globalCurrency = defaultCurrencyCode || '';

  return {
    isCurrencyActive: isCurrencyFlagOn && globalCurrency !== '',
    globalCurrency,
  };
}
