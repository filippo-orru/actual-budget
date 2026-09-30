import { useTranslation } from 'react-i18next';

import type { CSSProperties } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';

type ForeignAccountsNoteProps = {
  accounts: { id: string; name: string }[];
  style?: CSSProperties;
};

/** Tells the user which foreign-currency accounts a report leaves out. */
export function ForeignAccountsNote({
  accounts,
  style,
}: ForeignAccountsNoteProps) {
  const { t } = useTranslation();

  if (accounts.length === 0) {
    return null;
  }

  const names = accounts.map(account => account.name).join(', ');

  return (
    <Text
      data-testid="foreign-accounts-note"
      style={{ color: theme.pageTextSubdued, fontSize: 12, ...style }}
    >
      {accounts.length === 1
        ? t('1 foreign-currency account excluded: {{names}}', { names })
        : t('{{count}} foreign-currency accounts excluded: {{names}}', {
            count: accounts.length,
            names,
          })}
    </Text>
  );
}
