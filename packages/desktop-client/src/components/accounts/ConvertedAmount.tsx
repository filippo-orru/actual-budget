import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { CSSProperties } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { Tooltip } from '@actual-app/components/tooltip';

import { CurrencyProvider } from '#components/CurrencyProvider';
import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { useFormat } from '#hooks/useFormat';

function useUnavailableText(missingPairs: string[]) {
  const { t } = useTranslation();
  return t('Exchange rate {{pair}} unavailable', {
    pair: missingPairs.join(', '),
  });
}

type FormattedConvertedProps = {
  amount: number;
  style?: CSSProperties;
  testId?: string;
};

// Always formatted in the global currency
function GlobalCurrencyAmount({
  amount,
  style,
  testId,
}: FormattedConvertedProps) {
  const format = useFormat();
  return (
    <FinancialText
      data-testid={testId}
      style={{ whiteSpace: 'nowrap', ...style }}
    >
      <PrivacyFilter>{format(amount, 'financial')}</PrivacyFilter>
    </FinancialText>
  );
}

type ConvertedAmountProps = {
  /** Converted amount in the global currency; null if unavailable. */
  total: number | null;
  missingPairs: string[];
  style?: CSSProperties;
  testId?: string;
};

/**
 * Renders an amount converted into the global currency, or "—" with a
 * tooltip when a needed exchange rate is unavailable.
 */
export function ConvertedAmount({
  total,
  missingPairs,
  style,
  testId,
}: ConvertedAmountProps) {
  const unavailableText = useUnavailableText(missingPairs);

  if (total == null) {
    return (
      <Tooltip content={<Text>{unavailableText}</Text>}>
        <FinancialText
          data-testid={testId}
          aria-label={unavailableText}
          style={{ whiteSpace: 'nowrap', ...style }}
        >
          —
        </FinancialText>
      </Tooltip>
    );
  }

  return (
    <CurrencyProvider currencyCode={null}>
      <GlobalCurrencyAmount amount={total} style={style} testId={testId} />
    </CurrencyProvider>
  );
}

type ConvertedTooltipProps = {
  /** Converted amount in the global currency; null if unavailable. */
  converted: number | null | undefined;
  /** Unavailable pair, for example "EUR → USD". */
  pair: string;
  /** When false, the children are rendered untouched. */
  isEnabled?: boolean;
  children: ReactNode;
};

/** Hovering the children shows the amount converted into the global currency. */
export function ConvertedTooltip({
  converted,
  pair,
  isEnabled = true,
  children,
}: ConvertedTooltipProps) {
  const unavailableText = useUnavailableText([pair]);

  if (!isEnabled) {
    return children;
  }

  return (
    <Tooltip
      content={
        converted == null ? (
          <Text>{unavailableText}</Text>
        ) : (
          <CurrencyProvider currencyCode={null}>
            <GlobalCurrencyAmount amount={converted} />
          </CurrencyProvider>
        )
      }
    >
      {children}
    </Tooltip>
  );
}
