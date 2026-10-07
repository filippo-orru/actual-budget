import { useEffect, useRef, useState } from 'react';
import { Form } from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { FormError } from '@actual-app/components/form-error';
import { Input } from '@actual-app/components/input';
import { Paragraph } from '@actual-app/components/paragraph';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import { listen, send } from '@actual-app/core/platform/client/connection';
import { getDecimalPlaces } from '@actual-app/core/shared/currencies';
import { amountToInteger, integerToAmount } from '@actual-app/core/shared/util';
import type { BudgetSpaceEntity } from '@actual-app/core/types/models';
import { useQueryClient } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { Link } from '#components/common/Link';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useCurrencyOptions } from '#hooks/useCurrencyOptions';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useNavigate } from '#hooks/useNavigate';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { budgetRoutes } from '#util/budget-routes';

type Props = Extract<
  ModalType,
  { name: 'move-account-to-budget-space' }
>['options'];
type Review = {
  sourceBudget: { name: string; currencyCode: string };
  destinationBudget: { id: string; name: string; currencyCode: string };
  destinationAccountId: string;
  inputCurrency: string;
  transactionCount: number;
  sourceTransactionCount: number;
  excluded: Array<{ id: string }>;
  partialSplitExclusions: Array<{ id: string; excludedChildIds: string[] }>;
  counterpartCount: number;
  copiedRuleCount: number;
  skippedApplicableRuleCount: number;
  dateRange: string[] | null;
  convertedTotal: number | null;
  adjustment: number | null;
  finalBalance: number | null;
  missingRates: string[];
  representativeTransactions: Array<{
    id: string;
    date: string;
    sourceAmount: number;
    destinationAmount: number;
  }>;
  categoryCreations: Array<{
    id: string;
    groupId: string;
    name: string;
    groupName: string;
  }>;
  canCommit: boolean;
};
type Preparation = { token: string; review: Review };

function errorMessage(error: unknown, depth = 0): string {
  if (depth > 3) return 'An unknown error occurred.';
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null) {
    const details = error as Record<string, unknown>;
    if (typeof details.message === 'string' && details.message) {
      return details.message;
    }
    if (typeof details.error === 'string' && details.error) {
      return details.error;
    }
    if (details.error != null) return errorMessage(details.error, depth + 1);
    if (typeof details.code === 'string' && details.code) {
      return `The operation failed (${details.code}).`;
    }
    if (typeof details.reason === 'string' && details.reason) {
      return `The operation failed (${details.reason}).`;
    }
    if (details.cause != null) return errorMessage(details.cause, depth + 1);
    if (typeof details.stack === 'string' && details.stack) {
      return details.stack.split('\n')[0];
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Fall through to a useful generic message for cyclic error objects.
    }
    return 'An unknown error occurred.';
  }
  return String(error);
}

export function MoveAccountToBudgetSpaceModal({ account }: Props) {
  const { t } = useTranslation();
  const [fileId] = useMetadataPref('id');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { currencyOptions } = useCurrencyOptions({ includeNone: false });
  const [spaces, setSpaces] = useState<BudgetSpaceEntity[]>([]);
  const [destinationId, setDestinationId] = useState('');
  const [newSpaceName, setNewSpaceName] = useState('');
  const [newSpaceCurrency, setNewSpaceCurrency] = useState('');
  const [inputCurrency, setInputCurrency] = useState('');
  const [accountName, setAccountName] = useState(account.name);
  const [offBudget, setOffBudget] = useState(account.offbudget === 1);
  const [targetBalance, setTargetBalance] = useState('');
  const [preparation, setPreparation] = useState<Preparation | null>(null);
  const activeRequestId = useRef<string | null>(null);
  const activeOperationId = useRef<string | null>(null);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<
    'loading' | 'configure' | 'preparing' | 'review' | 'committing' | 'done'
  >('loading');
  const creatingSpace = useRef<Promise<BudgetSpaceEntity> | null>(null);
  const [blockers, setBlockers] = useState<Array<{
    type: string;
    id: string;
    name: string;
  }> | null>(null);

  useEffect(() => {
    return listen('account-migration-progress', event => {
      if (event.operationId !== activeOperationId.current) return;
      const labels = {
        'reading-transactions': t('Reading transactions'),
        'fetching-rates': t('Fetching exchange rates'),
        'preparing-preview': t('Preparing preview'),
        'review-ready': t('Review ready'),
        'moving-transactions': t('Moving transactions'),
        complete: t('Move complete'),
      };
      const counts = event.total
        ? ` (${event.completed ?? 0}/${event.total})`
        : '';
      setProgressText(`${labels[event.phase]}${counts}`);
    });
  }, [t]);

  useEffect(() => {
    let isCurrent = true;
    void Promise.all([
      send('account-migration/check', { sourceAccountId: account.id }),
      send('budget-spaces/get'),
    ])
      .then(([eligibility, budgetSpaces]) => {
        if (!isCurrent) return;
        setSpaces(budgetSpaces.filter(space => !space.tombstone));
        const otherSpace = budgetSpaces.find(
          space => !space.tombstone && space.id !== account.budget_id,
        );
        setInputCurrency(eligibility.sourceBudget.currencyCode || '');
        setDestinationId(otherSpace?.id ?? '__new__');
        const initialDestinationCurrency =
          eligibility.sourceBudget.currencyCode || '';
        setNewSpaceCurrency(initialDestinationCurrency);
        setNewSpaceName(initialDestinationCurrency);
        if (eligibility.blockers.length > 0) {
          setBlockers(eligibility.blockers);
          setPhase('configure');
        } else {
          setPhase('configure');
        }
      })
      .catch(cause => {
        if (isCurrent) {
          setError(errorMessage(cause));
          setPhase('configure');
        }
      });
    return () => {
      isCurrent = false;
      const requestId = activeRequestId.current;
      if (requestId) {
        void send('account-migration/cancel', { requestId });
      }
    };
  }, [account.budget_id, account.id, t]);

  const destination =
    destinationId === '__new__'
      ? {
          type: 'new' as const,
          name: newSpaceName,
          currencyCode: newSpaceCurrency,
        }
      : { type: 'existing' as const, budgetId: destinationId };
  const destinationOptions: [string, string][] = [
    ...spaces
      .filter(space => space.id !== account.budget_id)
      .map(
        space =>
          [space.id, `${space.name} (${space.currency_code})`] as [
            string,
            string,
          ],
      ),
    ['__new__', t('New budget space')],
  ];
  const destinationCurrency =
    destination.type === 'new'
      ? newSpaceCurrency
      : (spaces.find(space => space.id === destinationId)?.currency_code ?? '');

  async function prepare() {
    setError(null);
    setPhase('preparing');
    setConfirmed(false);
    if (preparation) {
      await send('account-migration/cancel', { token: preparation.token });
    }
    setPreparation(null);
    const requestId = crypto.randomUUID();
    activeRequestId.current = requestId;
    activeOperationId.current = requestId;
    try {
      const checked = await send('account-migration/check', {
        sourceAccountId: account.id,
      });
      if (activeRequestId.current !== requestId) return;
      if (checked.blockers.length > 0) {
        setBlockers(checked.blockers);
        setPhase('configure');
        return;
      }
      let target: number | undefined;
      if (targetBalance.trim() !== '') {
        const parsedBalance = Number(targetBalance);
        if (!Number.isFinite(parsedBalance)) {
          throw new Error(t('Enter a valid target balance.'));
        }
        target = amountToInteger(
          parsedBalance,
          getDecimalPlaces(destinationCurrency),
        );
      }
      if (activeRequestId.current !== requestId) return;
      let preparedDestination = destination;
      if (destination.type === 'new') {
        creatingSpace.current ??= send('budget-spaces/create', {
          name: destination.name,
          currencyCode: destination.currencyCode,
        });
        const spaceRequest = creatingSpace.current;
        let createdSpace: BudgetSpaceEntity;
        try {
          createdSpace = await spaceRequest;
        } catch (cause) {
          if (creatingSpace.current === spaceRequest) {
            creatingSpace.current = null;
          }
          throw cause;
        }
        setSpaces(current =>
          current.some(space => space.id === createdSpace.id)
            ? current
            : [...current, createdSpace],
        );
        if (creatingSpace.current === spaceRequest) {
          setDestinationId(current =>
            current === '__new__' ? createdSpace.id : current,
          );
        }
        preparedDestination = {
          type: 'existing',
          budgetId: createdSpace.id,
        };
        await queryClient.invalidateQueries({
          queryKey: budgetSpaceQueries.list(fileId).queryKey,
        });
      }
      if (activeRequestId.current !== requestId) return;
      const result = await send('account-migration/prepare', {
        requestId,
        sourceAccountId: account.id,
        destination: preparedDestination,
        inputCurrency,
        accountName,
        offBudget,
        targetBalance: target,
        adjustmentNote: t('Migration balance adjustment'),
      });
      if (activeRequestId.current !== requestId) return;
      setPreparation(result);
      setPhase('review');
    } catch (cause) {
      if (activeRequestId.current !== requestId) return;
      setError(errorMessage(cause));
      setPhase('configure');
    } finally {
      if (activeRequestId.current === requestId) {
        activeRequestId.current = null;
      }
    }
  }

  async function commit(close: () => void) {
    if (!preparation || !confirmed) return;
    setError(null);
    setPhase('committing');
    activeOperationId.current = preparation.token;
    setProgressText(t('Moving transactions'));
    try {
      const result = await send('account-migration/commit', {
        token: preparation.token,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['categories'] }),
        queryClient.invalidateQueries({ queryKey: ['category-groups'] }),
        queryClient.invalidateQueries({ queryKey: ['budget-spaces'] }),
        queryClient.invalidateQueries({ queryKey: ['budget'] }),
        queryClient.invalidateQueries({ queryKey: ['reports'] }),
      ]);
      setPhase('done');
      close();
      await queryClient.invalidateQueries({
        queryKey: budgetSpaceQueries.list(fileId).queryKey,
      });
      void navigate(budgetRoutes.account(result.budgetId, result.accountId));
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase('review');
    }
  }

  const amountLabel = (amount: number, currencyCode: string) =>
    `${currencyCode} ${integerToAmount(amount, getDecimalPlaces(currencyCode))}`;

  return (
    <Modal
      name="move-account-to-budget-space"
      containerProps={{
        style: { width: 'min(600px, 90vw)', maxWidth: 600, minWidth: 0 },
      }}
      isDismissable={phase !== 'committing'}
      isLoading={
        phase === 'loading' || phase === 'preparing' || phase === 'committing'
      }
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Move to budget space')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          {phase === 'preparing' || phase === 'committing' ? (
            <View style={{ gap: 12 }}>
              <Paragraph aria-live="polite">
                {progressText || (
                  <Trans>Preparing the account migration…</Trans>
                )}
              </Paragraph>
              {phase === 'preparing' && (
                <Button
                  onPress={() => {
                    const requestId = activeRequestId.current;
                    activeRequestId.current = null;
                    activeOperationId.current = null;
                    if (requestId) {
                      void send('account-migration/cancel', { requestId });
                    }
                    setPhase('configure');
                  }}
                >
                  <Trans>Cancel preparation</Trans>
                </Button>
              )}
            </View>
          ) : blockers && blockers.length > 0 ? (
            <View style={{ gap: 12 }}>
              <Paragraph>
                <Trans>
                  This account cannot be moved until the following connections
                  or automations are resolved:
                </Trans>
              </Paragraph>
              {blockers.map(blocker => (
                <Text key={`${blocker.type}-${blocker.name}`}>
                  {blocker.type === 'schedule' ? (
                    <Link
                      variant="internal"
                      to={budgetRoutes.schedules(account.budget_id, blocker.id)}
                    >
                      {blocker.name}
                    </Link>
                  ) : blocker.type === 'rule' ? (
                    <Link
                      variant="internal"
                      to={budgetRoutes.rules(account.budget_id, blocker.id)}
                    >
                      {blocker.name}
                    </Link>
                  ) : (
                    blocker.name
                  )}
                </Text>
              ))}
              {blockers.some(blocker => blocker.type === 'bank-link') && (
                <Paragraph>
                  {t(
                    'Unlink this account from its bank before moving it. The account will not be unlinked automatically.',
                  )}
                </Paragraph>
              )}
            </View>
          ) : phase === 'review' && preparation ? (
            <View style={{ gap: 12 }}>
              <Paragraph>
                {t(
                  'Move {{count}} transactions from {{source}} to {{destination}}.',
                  {
                    count: preparation.review.transactionCount,
                    source: preparation.review.sourceBudget.name,
                    destination: preparation.review.destinationBudget.name,
                  },
                )}
              </Paragraph>
              <Text>
                <Trans>Date range</Trans>:{' '}
                {preparation.review.dateRange?.join(' – ') ??
                  t('No transactions')}
              </Text>
              <Text>
                <Trans>Excluded reconciliation adjustments</Trans>:{' '}
                {preparation.review.excluded.length}
              </Text>
              <Text>
                <Trans>Partial split exclusions</Trans>:{' '}
                {preparation.review.partialSplitExclusions.length}
              </Text>
              <Text>
                <Trans>Transfer counterparts to detach</Trans>:{' '}
                {preparation.review.counterpartCount}
              </Text>
              <Text>
                <Trans>Rules to copy</Trans>:{' '}
                {preparation.review.copiedRuleCount}
              </Text>
              {preparation.review.skippedApplicableRuleCount > 0 && (
                <Text>
                  <Trans>
                    Applicable rules skipped because their referenced categories
                    or automation links could not be safely mapped:
                  </Trans>{' '}
                  {preparation.review.skippedApplicableRuleCount}
                </Text>
              )}
              {preparation.review.convertedTotal != null && (
                <Text>
                  <Trans>Converted total</Trans>:{' '}
                  <FinancialText>
                    {amountLabel(
                      preparation.review.convertedTotal,
                      preparation.review.destinationBudget.currencyCode,
                    )}
                  </FinancialText>
                </Text>
              )}
              {preparation.review.adjustment != null &&
                preparation.review.adjustment !== 0 && (
                  <Text>
                    <Trans>Balance adjustment</Trans>:{' '}
                    <FinancialText>
                      {amountLabel(
                        preparation.review.adjustment,
                        preparation.review.destinationBudget.currencyCode,
                      )}
                    </FinancialText>
                  </Text>
                )}
              {preparation.review.finalBalance != null && (
                <Text>
                  <Trans>Final balance</Trans>:{' '}
                  <FinancialText>
                    {amountLabel(
                      preparation.review.finalBalance,
                      preparation.review.destinationBudget.currencyCode,
                    )}
                  </FinancialText>
                </Text>
              )}
              <details>
                <summary>
                  <Trans>Representative converted transactions</Trans>
                </summary>
                <View style={{ gap: 6, paddingTop: 8 }}>
                  {preparation.review.representativeTransactions.map(
                    transaction => (
                      <Text key={transaction.id}>
                        {transaction.date}:{' '}
                        <FinancialText>
                          {amountLabel(
                            transaction.sourceAmount,
                            preparation.review.inputCurrency,
                          )}
                        </FinancialText>
                        {' → '}
                        <FinancialText>
                          {amountLabel(
                            transaction.destinationAmount,
                            preparation.review.destinationBudget.currencyCode,
                          )}
                        </FinancialText>
                      </Text>
                    ),
                  )}
                </View>
              </details>
              {preparation.review.excluded.length > 0 && (
                <details>
                  <summary>
                    <Trans>Inspect excluded reconciliation adjustments</Trans>
                  </summary>
                  <View style={{ gap: 4, paddingTop: 8 }}>
                    {preparation.review.excluded
                      .slice(0, 100)
                      .map(transaction => (
                        <Text key={transaction.id}>{transaction.id}</Text>
                      ))}
                    {preparation.review.excluded.length > 100 && (
                      <Text>
                        {t(
                          'Showing the first 100 of {{count}} excluded transactions.',
                          {
                            count: preparation.review.excluded.length,
                          },
                        )}
                      </Text>
                    )}
                  </View>
                </details>
              )}
              {preparation.review.missingRates.length > 0 && (
                <>
                  <FormError>
                    {t('Missing historical rates for {{dates}}.', {
                      dates: preparation.review.missingRates.join(', '),
                    })}
                  </FormError>
                  <Button onPress={() => void prepare()}>
                    <Trans>Retry rate lookup</Trans>
                  </Button>
                </>
              )}
              {preparation.review.categoryCreations.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontWeight: 600 }}>
                    <Trans>Category matching</Trans>
                  </Text>
                  <Paragraph>
                    {t(
                      "Categories will be matched automatically based on name. {{count}} categories that don't exist will be created.",
                      { count: preparation.review.categoryCreations.length },
                    )}
                  </Paragraph>
                </View>
              )}
              <Paragraph>
                <Trans>
                  Transactions will be copied to the destination account, then
                  deleted from the original account to avoid double-counting
                  across budget spaces. The original account will be closed.
                  Historical balances, reports, and budget availability in the
                  original space will change.
                </Trans>
              </Paragraph>
              <Paragraph>
                {t(
                  'Before moving this account, download a backup using Export data in Settings. The migration will not create a backup automatically. Restoring a backup restores the whole file, including every budget space, and may discard changes made after the backup.',
                )}
              </Paragraph>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={event => setConfirmed(event.currentTarget.checked)}
                />{' '}
                <Trans>
                  I have downloaded a backup and understand this will delete the
                  original account history and close the original account.
                </Trans>
              </label>
              {error && <FormError>{error}</FormError>}
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'flex-end',
                  gap: 8,
                }}
              >
                <Button
                  onPress={() => {
                    void send('account-migration/cancel', {
                      token: preparation.token,
                    });
                    setPreparation(null);
                    setPhase('configure');
                    setConfirmed(false);
                  }}
                >
                  <Trans>Edit options</Trans>
                </Button>
                <Button
                  variant="primary"
                  isDisabled={
                    !confirmed ||
                    !preparation.review.canCommit ||
                    preparation.review.missingRates.length > 0
                  }
                  onPress={() => void commit(() => state.close())}
                >
                  <Trans>Move account</Trans>
                </Button>
              </View>
            </View>
          ) : (
            <Form
              onSubmit={event => {
                event.preventDefault();
                void prepare();
              }}
            >
              <View style={{ gap: 12 }}>
                <Paragraph>
                  {t(
                    'Amounts are interpreted in the selected input currency and converted to the destination currency using historical rates on each transaction date. Daily reference rates and prior rounding cannot reconstruct the exact original foreign amounts.',
                  )}
                </Paragraph>
                <label style={{ display: 'grid', gap: 6 }}>
                  <Text>
                    <Trans>Destination budget space</Trans>
                  </Text>
                  <Select
                    aria-label={t('Destination budget space')}
                    value={destinationId}
                    onChange={value => {
                      setDestinationId(value);
                      setTargetBalance('');
                      creatingSpace.current = null;
                      if (preparation) {
                        void send('account-migration/cancel', {
                          token: preparation.token,
                        });
                        setPreparation(null);
                        setPhase('configure');
                      }
                    }}
                    options={destinationOptions}
                  />
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                  <Text>
                    <Trans>Amounts entered in</Trans>
                  </Text>
                  <Select
                    aria-label={t('Amounts entered in')}
                    value={inputCurrency}
                    onChange={setInputCurrency}
                    options={currencyOptions}
                  />
                </label>
                {destination.type === 'new' && (
                  <>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <Text>
                        <Trans>Destination currency</Trans>
                      </Text>
                      <Select
                        aria-label={t('Destination currency')}
                        value={newSpaceCurrency}
                        onChange={value => {
                          setNewSpaceCurrency(value);
                          setNewSpaceName(value);
                          setTargetBalance('');
                          creatingSpace.current = null;
                        }}
                        options={currencyOptions}
                      />
                    </label>
                    <label style={{ display: 'grid', gap: 6 }}>
                      <Text>
                        <Trans>New budget space name</Trans>
                      </Text>
                      <Input
                        value={newSpaceName}
                        onChange={event => {
                          setNewSpaceName(event.currentTarget.value);
                          creatingSpace.current = null;
                        }}
                      />
                    </label>
                  </>
                )}
                <label style={{ display: 'grid', gap: 6 }}>
                  <Text>
                    <Trans>Destination account name</Trans>
                  </Text>
                  <Input
                    value={accountName}
                    onChange={event =>
                      setAccountName(event.currentTarget.value)
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={!offBudget}
                    onChange={event =>
                      setOffBudget(!event.currentTarget.checked)
                    }
                  />{' '}
                  <Trans>On budget</Trans>
                </label>
                <label style={{ display: 'grid', gap: 6 }}>
                  <Text>
                    {t('Current account balance in {{currency}} (optional)', {
                      currency: destinationCurrency,
                    })}
                  </Text>
                  <Input
                    type="number"
                    value={targetBalance}
                    onChange={event =>
                      setTargetBalance(event.currentTarget.value)
                    }
                  />
                </label>
                <Paragraph>
                  {t(
                    'This is the total ledger balance, including uncleared transactions, not the bank available balance or only the cleared balance.',
                  )}
                </Paragraph>
                <Paragraph>
                  {t(
                    'Moving the account changes historical budgets and reports in the original space. Reconciled status is not carried over.',
                  )}
                </Paragraph>
                <Paragraph>
                  <Trans>
                    Do not edit this file on another device during the move.
                  </Trans>
                </Paragraph>
                {error && <FormError>{error}</FormError>}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'flex-end',
                    gap: 8,
                  }}
                >
                  <Button onPress={() => state.close()}>
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button
                    variant="primary"
                    type="submit"
                    isDisabled={
                      !destinationId ||
                      !inputCurrency ||
                      !accountName.trim() ||
                      (destination.type === 'new' &&
                        (!newSpaceName.trim() || !newSpaceCurrency))
                    }
                  >
                    <Trans>Prepare review</Trans>
                  </Button>
                </View>
              </View>
            </Form>
          )}
        </>
      )}
    </Modal>
  );
}
