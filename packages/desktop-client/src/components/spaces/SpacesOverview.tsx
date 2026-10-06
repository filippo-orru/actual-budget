import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { SvgAdd, SvgCog } from '@actual-app/components/icons/v1';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { spacing } from '@actual-app/components/tokens';
import { View } from '@actual-app/components/view';
import { useQueries, useQuery } from '@tanstack/react-query';

import { accountQueries } from '#accounts';
import { budgetSpaceQueries } from '#budget-spaces/queries';
import { useOpenCreateBudgetSpace } from '#budget-spaces/useOpenCreateBudgetSpace';
import { Link } from '#components/common/Link';
import { CurrencyProvider } from '#components/CurrencyProvider';
import { FinancialText } from '#components/FinancialText';
import { Page } from '#components/Page';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { CellValue } from '#components/spreadsheet/CellValue';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useFormat } from '#hooks/useFormat';
import { useMetadataPref } from '#hooks/useMetadataPref';
import * as bindings from '#spreadsheet/bindings';
import { budgetRoutes } from '#util/budget-routes';

export function SpacesOverview() {
  const { t } = useTranslation();
  const [fileId] = useMetadataPref('id');
  const { data: spaces = [], isLoading } = useQuery(
    budgetSpaceQueries.list(fileId),
  );
  const activeSpaces = spaces.filter(space => !space.tombstone);
  const accountQueriesBySpace = useQueries({
    queries: activeSpaces.map(space => accountQueries.list(space.id)),
  });
  const multiBudgetEnabled = useFeatureFlag('multiCurrency');
  const openCreate = useOpenCreateBudgetSpace();
  const { isNarrowWidth } = useResponsive();

  return (
    <Page header={t('Budget Spaces')}>
      <View
        style={{
          maxWidth: 900,
          width: '100%',
          gap: spacing.md,
          marginTop: 10,
          paddingBottom: 20,
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          {multiBudgetEnabled && (
            <Button onPress={() => void openCreate()}>
              <SvgAdd width={10} height={10} style={{ marginRight: 5 }} />
              <Trans>Add new budget space</Trans>
            </Button>
          )}
        </View>

        <View
          role="list"
          aria-label={t('Budget spaces')}
          style={{
            display: 'grid',
            gridTemplateColumns: isNarrowWidth
              ? '1fr'
              : 'repeat(2, minmax(0, 1fr))',
            alignContent: 'start',
            gap: spacing.md,
          }}
        >
          {isLoading ? (
            <Text role="listitem" style={{ color: theme.pageTextSubdued }}>
              <Trans>Loading…</Trans>
            </Text>
          ) : (
            activeSpaces.map((space, index) => {
              const accountQuery = accountQueriesBySpace[index];
              const accounts = (accountQuery?.data ?? []).filter(
                account => !account.closed && !account.tombstone,
              );

              return (
                <View
                  key={space.id}
                  role="listitem"
                  style={{
                    gap: spacing.sm,
                    padding: spacing.md,
                    border: `1px solid ${theme.pillBorderDark}`,
                    borderRadius: 4,
                    backgroundColor: theme.pillBackground,
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: spacing.md,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'baseline',
                        gap: spacing.xs,
                        minWidth: 0,
                      }}
                    >
                      <Text
                        style={{
                          color: theme.pageText,
                          fontSize: 18,
                          fontWeight: 600,
                        }}
                      >
                        {space.name}
                      </Text>
                      {space.name !== space.currency_code && (
                        <Text style={{ color: theme.pageTextSubdued }}>
                          {space.currency_code || t('No currency')}
                        </Text>
                      )}
                    </View>
                    <Link
                      variant="internal"
                      to={budgetRoutes.settings(space.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: spacing.sm,
                        flexShrink: 0,
                        textDecoration: 'none',
                        ':hover': { textDecoration: 'underline' },
                      }}
                    >
                      <SvgCog width={14} height={14} />
                      <Trans>Settings</Trans>
                    </Link>
                  </View>

                  <View
                    role="list"
                    aria-label={t('{{spaceName}} accounts', {
                      spaceName: space.name,
                    })}
                    style={{ gap: spacing.xs }}
                  >
                    {accountQuery?.isFetching && accounts.length === 0 ? (
                      <Text
                        role="listitem"
                        style={{ color: theme.pageTextSubdued }}
                      >
                        <Trans>Loading…</Trans>
                      </Text>
                    ) : accounts.length === 0 ? (
                      <Text
                        role="listitem"
                        style={{ color: theme.pageTextSubdued }}
                      >
                        <Trans>No accounts</Trans>
                      </Text>
                    ) : (
                      accounts.map(account => (
                        <View key={account.id} role="listitem">
                          <View
                            style={{
                              display: 'flex',
                              flexDirection: 'row',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: spacing.md,
                              padding: `${spacing.xs}px 0`,
                              color: theme.pageText,
                            }}
                          >
                            <Link
                              variant="internal"
                              to={budgetRoutes.account(space.id, account.id)}
                              style={{
                                textDecoration: 'none',
                                ':hover': { textDecoration: 'underline' },
                              }}
                            >
                              {account.name}
                            </Link>
                            <CurrencyProvider
                              currencyCode={space.currency_code ?? ''}
                            >
                              <AccountBalance accountId={account.id} />
                            </CurrencyProvider>
                          </View>
                        </View>
                      ))
                    )}
                  </View>

                  <CurrencyProvider currencyCode={space.currency_code ?? ''}>
                    {accounts.length > 1 && <SpaceTotal budgetId={space.id} />}
                  </CurrencyProvider>
                </View>
              );
            })
          )}
        </View>
      </View>
    </Page>
  );
}

function SpaceTotal({ budgetId }: { budgetId: string }) {
  return (
    <CellValue<'account', `accounts-balance-${string}`>
      binding={bindings.allAccountBalance(budgetId)}
      type="financial"
    >
      {({ value }) =>
        value != null && value !== 0 ? (
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              gap: spacing.md,
              borderTop: `1px solid ${theme.pillBorderDark}`,
              paddingTop: spacing.sm,
              fontWeight: 600,
            }}
          >
            <Text>
              <Trans>Total</Trans>
            </Text>
            <TotalAmount amount={value} />
          </View>
        ) : null
      }
    </CellValue>
  );
}

function TotalAmount({ amount }: { amount: number }) {
  const format = useFormat();
  return (
    <PrivacyFilter activationFilters={[true]}>
      <FinancialText>{format(amount, 'financial')}</FinancialText>
    </PrivacyFilter>
  );
}

function AccountBalance({ accountId }: { accountId: string }) {
  return (
    <CellValue<'account', 'balance'>
      binding={bindings.accountBalance(accountId)}
      type="financial"
    />
  );
}
