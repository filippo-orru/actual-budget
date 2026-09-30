import type { CSSProperties } from '@actual-app/components/styles';
import type { AccountEntity } from '@actual-app/core/types/models';

import { AccountBalanceCell } from '#components/accounts/AccountBalanceCell';
import { ConvertedTotalCell } from '#components/accounts/ConvertedTotalCell';
import type { AccountsScope } from '#components/accounts/ConvertedTotalCell';
import { CellValue, CellValueText } from '#components/spreadsheet/CellValue';
import type { Binding, SheetFields } from '#spreadsheet';

type SidebarBalanceProps<FieldName extends SheetFields<'account'>> = {
  binding: Binding<'account', FieldName>;
  style?: CSSProperties;
  testId?: string;
  /** Single account row: native balance, converted in a tooltip. */
  account?: AccountEntity;
  /** Aggregate row: converted total when foreign accounts are involved. */
  scope?: AccountsScope;
};

export function SidebarBalance<FieldName extends SheetFields<'account'>>({
  binding,
  style,
  testId,
  account,
  scope,
}: SidebarBalanceProps<FieldName>) {
  const nativeBalance = (
    <CellValue<'account', FieldName> binding={binding} type="financial">
      {props => (
        <CellValueText<'account', FieldName>
          {...props}
          data-testid={testId ?? props.name}
          style={{ textAlign: 'right', ...style }}
        />
      )}
    </CellValue>
  );

  if (account) {
    return (
      <AccountBalanceCell account={account}>{nativeBalance}</AccountBalanceCell>
    );
  }
  if (scope) {
    return (
      <ConvertedTotalCell
        scope={scope}
        testId={testId}
        style={{ textAlign: 'right', ...style }}
      >
        {nativeBalance}
      </ConvertedTotalCell>
    );
  }
  return nativeBalance;
}
