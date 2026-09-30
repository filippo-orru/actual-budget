import React, { useRef } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgArrowButtonRight1 } from '@actual-app/components/icons/v2';
import type { CSSProperties } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { q } from '@actual-app/core/shared/query';
import type { Query } from '@actual-app/core/shared/query';
import { getScheduledAmount } from '@actual-app/core/shared/schedules';
import { isPreviewId } from '@actual-app/core/shared/transactions';
import type { AccountEntity } from '@actual-app/core/types/models';
import { useHover } from 'usehooks-ts';

import { FinancialText } from '#components/FinancialText';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { CellValue, CellValueText } from '#components/spreadsheet/CellValue';
import { convertNative, useBalanceMode } from '#hooks/useBalanceMode';
import type { BalanceMode } from '#hooks/useBalanceMode';
import { useCachedSchedules } from '#hooks/useCachedSchedules';
import { useConvertedQueryTotal } from '#hooks/useConvertedTotal';
import { useFormat } from '#hooks/useFormat';
import { useSelectedItems } from '#hooks/useSelected';
import { useSheetValue } from '#hooks/useSheetValue';
import type { Binding } from '#spreadsheet';

import { ConvertedAmount, ConvertedTooltip } from './ConvertedAmount';

const PLAIN_MODE: BalanceMode = { kind: 'plain' };

// Sums of a mixed-currency view are computed per account and converted into
// the global currency.
function MixedAmount({
  query,
  extra,
  getStyle,
}: {
  query: Query;
  extra?: Record<string, number>;
  getStyle?: (total: number | null) => CSSProperties;
}) {
  const { total, missingPairs, isLoading } = useConvertedQueryTotal(
    query,
    extra,
  );

  if (isLoading) {
    return null;
  }
  return (
    <ConvertedAmount
      total={total}
      missingPairs={missingPairs}
      style={getStyle?.(total)}
    />
  );
}

type DetailedBalanceProps = {
  name: string;
  balance: number;
  isExactBalance?: boolean;
  mode?: BalanceMode;
  /** Transactions query for this balance (used in mixed views). */
  query?: Query | null;
  /** Extra native amounts per account (used in mixed views). */
  extra?: Record<string, number>;
};

function DetailedBalance({
  name,
  balance,
  isExactBalance = true,
  mode = PLAIN_MODE,
  query = null,
  extra,
}: DetailedBalanceProps) {
  const format = useFormat();

  const pill = (
    <Text
      style={{
        borderRadius: 4,
        padding: '4px 6px',
        color: theme.pillText,
        backgroundColor: theme.pillBackground,
      }}
    >
      {name}{' '}
      {mode.kind === 'mixed' && query ? (
        <>
          {!isExactBalance && '~ '}
          <MixedAmount query={query} extra={extra} />
        </>
      ) : (
        <PrivacyFilter>
          <FinancialText style={{ fontWeight: 600 }}>
            {!isExactBalance && '~ '}
            {format(balance, 'financial')}
          </FinancialText>
        </PrivacyFilter>
      )}
    </Text>
  );

  if (mode.kind === 'single') {
    return (
      <ConvertedTooltip
        converted={convertNative(mode, balance)}
        pair={`${mode.currency} → ${mode.globalCurrency}`}
      >
        {pill}
      </ConvertedTooltip>
    );
  }
  return pill;
}

type SelectedBalanceProps = {
  selectedItems: Set<string>;
  account?: AccountEntity;
  mode?: BalanceMode;
};

export function SelectedBalance({
  selectedItems,
  account,
  mode = PLAIN_MODE,
}: SelectedBalanceProps) {
  const { t } = useTranslation();

  const name = `selected-balance-${[...selectedItems].join('-')}`;

  const rows = useSheetValue<'balance', `selected-transactions-${string}`>({
    name: name as `selected-transactions-${string}`,
    query: q('transactions')
      .filter({
        id: { $oneof: [...selectedItems] },
        parent_id: { $oneof: [...selectedItems] },
      })
      .select('id'),
  });
  const ids = new Set((rows || []).map((r: { id: string }) => r.id));

  const finalIds = [...selectedItems].filter(id => !ids.has(id));
  const selectedQuery = q('transactions')
    .filter({ id: { $oneof: finalIds } })
    .options({ splits: 'all' });
  let balance = useSheetValue<'balance', `selected-balance-${string}`>({
    name: (name + '-sum') as `selected-balance-${string}`,
    query: selectedQuery.calculate({ $sum: '$amount' }),
  });

  let scheduleBalance = 0;
  const scheduleByAccount: Record<string, number> = {};

  const { isLoading, schedules = [] } = useCachedSchedules();

  if (isLoading) {
    return null;
  }

  let isExactBalance = true;

  for (const id of [...selectedItems].filter(isPreviewId)) {
    // Preview IDs are in the format `preview/<schedule_id>/<date>`
    const scheduleId = id.slice(8).split('/')[0];
    const schedule = schedules.find(s => s.id === scheduleId);
    if (schedule) {
      // If a schedule is `between X and Y` then we calculate the average
      if (schedule._amountOp === 'isbetween') {
        isExactBalance = false;
      }

      let amount: number;
      if (!account || account.id === schedule._account) {
        amount = getScheduledAmount(schedule._amount);
      } else {
        amount = -getScheduledAmount(schedule._amount);
      }
      scheduleBalance += amount;
      scheduleByAccount[schedule._account] =
        (scheduleByAccount[schedule._account] ?? 0) + amount;
    }
  }

  if (typeof balance !== 'number' && !scheduleBalance) {
    return null;
  } else {
    balance = (balance ?? 0) + scheduleBalance;
  }

  return (
    <DetailedBalance
      name={t('Selected balance:')}
      balance={balance}
      isExactBalance={isExactBalance}
      mode={mode}
      query={selectedQuery}
      extra={scheduleByAccount}
    />
  );
}

type FilteredBalanceProps = {
  filteredAmount?: number | null;
  filteredQuery?: Query | null;
  mode?: BalanceMode;
};

function FilteredBalance({
  filteredAmount,
  filteredQuery,
  mode,
}: FilteredBalanceProps) {
  const { t } = useTranslation();

  return (
    <DetailedBalance
      name={t('Filtered balance:')}
      balance={filteredAmount ?? 0}
      isExactBalance
      mode={mode}
      query={filteredQuery}
    />
  );
}

type MoreBalancesProps = {
  balanceQuery: { name: `balance-query-${string}`; query: Query };
  mode: BalanceMode;
};

function MoreBalances({ balanceQuery, mode }: MoreBalancesProps) {
  const { t } = useTranslation();

  const clearedQuery = balanceQuery.query.filter({ cleared: true });
  const unclearedQuery = balanceQuery.query.filter({ cleared: false });
  const cleared = useSheetValue<'balance', `balance-query-${string}-cleared`>({
    name: (balanceQuery.name + '-cleared') as `balance-query-${string}-cleared`,
    query: clearedQuery,
  });
  const uncleared = useSheetValue<
    'balance',
    `balance-query-${string}-uncleared`
  >({
    name: (balanceQuery.name +
      '-uncleared') as `balance-query-${string}-uncleared`,
    query: unclearedQuery,
  });

  return (
    <>
      <DetailedBalance
        name={t('Cleared total:')}
        balance={cleared ?? 0}
        mode={mode}
        query={clearedQuery}
      />
      <DetailedBalance
        name={t('Uncleared total:')}
        balance={uncleared ?? 0}
        mode={mode}
        query={unclearedQuery}
      />
    </>
  );
}

function balanceColor(value: number | null) {
  return value == null || value === 0
    ? theme.pageTextSubdued
    : value < 0
      ? theme.numberNegative
      : theme.numberPositive;
}

type BalancesProps = {
  balanceQuery: { name: `balance-query-${string}`; query: Query };
  showExtraBalances: boolean;
  onToggleExtraBalances: () => void;
  account?: AccountEntity;
  /** Id of the viewed account, or a special view ("offbudget", ...). */
  accountId?: string;
  isFiltered: boolean;
  filteredAmount?: number | null;
  filteredQuery?: Query | null;
};

export function Balances({
  balanceQuery,
  showExtraBalances,
  onToggleExtraBalances,
  account,
  accountId,
  isFiltered,
  filteredAmount,
  filteredQuery,
}: BalancesProps) {
  const selectedItems = useSelectedItems();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isButtonHovered = useHover(buttonRef as RefObject<HTMLButtonElement>);
  const mode = useBalanceMode(account, accountId);

  const mainStyle: CSSProperties = { fontSize: 22, fontWeight: 400 };

  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        marginTop: -5,
        marginLeft: -5,
        gap: 10,
      }}
    >
      <Button
        ref={buttonRef}
        data-testid="account-balance"
        variant="bare"
        onPress={onToggleExtraBalances}
        style={{
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        {mode.kind === 'mixed' ? (
          <MixedAmount
            query={balanceQuery.query}
            getStyle={total => ({ ...mainStyle, color: balanceColor(total) })}
          />
        ) : (
          <CellValue
            binding={
              { ...balanceQuery, value: 0 } as Binding<
                'balance',
                `balance-query-${string}`
              >
            }
            type="financial"
          >
            {props => {
              const value = (
                <CellValueText
                  {...props}
                  style={{ ...mainStyle, color: balanceColor(props.value) }}
                />
              );
              return mode.kind === 'single' ? (
                <ConvertedTooltip
                  converted={convertNative(mode, props.value ?? 0)}
                  pair={`${mode.currency} → ${mode.globalCurrency}`}
                >
                  {value}
                </ConvertedTooltip>
              ) : (
                value
              );
            }}
          </CellValue>
        )}

        <SvgArrowButtonRight1
          style={{
            width: 10,
            height: 10,
            marginLeft: 10,
            color: theme.pillText,
            transform: showExtraBalances ? 'rotateZ(180deg)' : 'rotateZ(0)',
            opacity:
              isButtonHovered || selectedItems.size > 0 || showExtraBalances
                ? 1
                : 0,
          }}
        />
      </Button>

      {showExtraBalances && (
        <MoreBalances balanceQuery={balanceQuery} mode={mode} />
      )}

      {selectedItems.size > 0 && (
        <SelectedBalance
          selectedItems={selectedItems}
          account={account}
          mode={mode}
        />
      )}
      {isFiltered && (
        <FilteredBalance
          filteredAmount={filteredAmount}
          filteredQuery={filteredQuery}
          mode={mode}
        />
      )}
    </View>
  );
}
