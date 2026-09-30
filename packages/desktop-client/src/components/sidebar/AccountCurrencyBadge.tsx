import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import type { AccountEntity } from '@actual-app/core/types/models';

import { useCurrencyFeature } from '#hooks/useCurrencyFeature';

type AccountCurrencyBadgeProps = {
  account?: Pick<AccountEntity, 'currency'>;
};

// Shows the account's currency code when it differs from the global currency
export function AccountCurrencyBadge({ account }: AccountCurrencyBadgeProps) {
  const { isCurrencyActive, globalCurrency } = useCurrencyFeature();

  if (!isCurrencyActive || !account?.currency) {
    return null;
  }
  if (account.currency === globalCurrency) {
    return null;
  }

  return (
    <Text
      style={{
        marginLeft: 5,
        fontSize: '0.8em',
        color: theme.pageTextSubdued,
      }}
    >
      {account.currency}
    </Text>
  );
}
