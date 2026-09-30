import { useTranslation } from 'react-i18next';

import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';

type NetWorthRateWarningProps = {
  missingPairs?: string[];
};

/** Warns that exchange rates are missing for some periods of the chart. */
export function NetWorthRateWarning({
  missingPairs = [],
}: NetWorthRateWarningProps) {
  const { t } = useTranslation();

  if (missingPairs.length === 0) {
    return null;
  }

  return (
    <Text
      data-testid="net-worth-rate-warning"
      style={{ color: theme.warningText, marginBottom: 5 }}
    >
      {t('Exchange rates unavailable for {{pairs}} for some periods', {
        pairs: missingPairs.join(', '),
      })}
    </Text>
  );
}
