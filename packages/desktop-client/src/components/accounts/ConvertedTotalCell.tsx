import type { ReactNode } from 'react';

import type { CSSProperties } from '@actual-app/components/styles';
import type { AccountEntity } from '@actual-app/core/types/models';

import { useAccounts } from '#hooks/useAccounts';
import { useConvertedTotal } from '#hooks/useConvertedTotal';
import { useMultiCurrency } from '#hooks/useMultiCurrency';

import { ConvertedAmount } from './ConvertedAmount';

export type AccountsScope =
  | { kind: 'all' }
  | { kind: 'onbudget' }
  | { kind: 'offbudget' }
  | { kind: 'group'; groupId: string; offbudget: boolean };

export function getScopeAccounts(
  accounts: AccountEntity[],
  scope: AccountsScope,
): AccountEntity[] {
  return accounts.filter(account => {
    if (account.closed) {
      return false;
    }
    switch (scope.kind) {
      case 'all':
        return true;
      case 'onbudget':
        return !account.offbudget;
      case 'offbudget':
        return !!account.offbudget;
      default:
        return (
          account.account_group_id === scope.groupId &&
          !!account.offbudget === scope.offbudget
        );
    }
  });
}

type ConvertedTotalCellProps = {
  scope: AccountsScope;
  style?: CSSProperties;
  testId?: string;
  /** The regular (unconverted) balance, used when no foreign account is involved. */
  children: ReactNode;
};

function ConvertedTotal({
  accountIds,
  style,
  testId,
}: {
  accountIds: string[];
  style?: CSSProperties;
  testId?: string;
}) {
  const { total, missingPairs, isLoading } = useConvertedTotal(accountIds);

  if (isLoading) {
    return null;
  }

  return (
    <ConvertedAmount
      total={total}
      missingPairs={missingPairs}
      style={style}
      testId={testId}
    />
  );
}

/**
 * Shows an aggregate balance converted into the global currency when the
 * scope contains at least one foreign account. Otherwise renders `children`,
 * the regular balance binding.
 */
export function ConvertedTotalCell({
  scope,
  style,
  testId,
  children,
}: ConvertedTotalCellProps) {
  const { isEnabled, isForeign } = useMultiCurrency();
  const { data: accounts = [] } = useAccounts();

  const scopeAccounts = getScopeAccounts(accounts, scope);
  const hasForeign = isEnabled && scopeAccounts.some(a => isForeign(a));

  if (!hasForeign) {
    return children;
  }

  return (
    <ConvertedTotal
      accountIds={scopeAccounts.map(a => a.id)}
      style={style}
      testId={testId}
    />
  );
}
