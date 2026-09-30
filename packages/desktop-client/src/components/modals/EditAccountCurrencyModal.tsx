import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Paragraph } from '@actual-app/components/paragraph';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { useQuery } from '@tanstack/react-query';

import { useSetAccountCurrencyMutation } from '#accounts';
import {
  AccountCurrencyField,
  resolveAccountCurrency,
} from '#components/accounts/AccountCurrencyField';
import type { AccountCurrencyValue } from '#components/accounts/AccountCurrencyField';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { useCurrencyFeature } from '#hooks/useCurrencyFeature';
import { useCurrencyOptions } from '#hooks/useCurrencyOptions';
import { closeModal } from '#modals/modalsSlice';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

type EditAccountCurrencyModalProps = Extract<
  ModalType,
  { name: 'edit-account-currency' }
>['options'];

type Conflict = {
  transactionId: string;
  date: string;
  accountName: string;
  otherAccountName: string;
};

export function EditAccountCurrencyModal({
  account,
}: EditAccountCurrencyModalProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { globalCurrency } = useCurrencyFeature();
  const { currencyTranslations } = useCurrencyOptions();
  const setCurrency = useSetAccountCurrencyMutation();

  const [value, setValue] = useState<AccountCurrencyValue>({
    useCustomCurrency: false,
    currency: globalCurrency,
  });
  const currency = resolveAccountCurrency(value, globalCurrency);

  const isUnassigned = account.currency == null;

  const { data: conflicts = [] } = useQuery({
    queryKey: ['account-currency-conflicts', account.id, currency],
    queryFn: async (): Promise<Conflict[]> =>
      send('account-currency-conflicts', { id: account.id, currency }),
    enabled: isUnassigned && currency !== '',
  });
  const isBlocked = conflicts.length > 0;

  return (
    <Modal name="edit-account-currency">
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Edit currency')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ gap: 10, lineHeight: 1.5 }}>
            <Text style={{ fontWeight: 600 }}>{account.name}</Text>

            {isUnassigned ? (
              <>
                <AccountCurrencyField
                  value={value}
                  onChange={setValue}
                  globalCurrency={globalCurrency}
                />
                <Paragraph style={{ color: theme.warningText }}>
                  <Trans>
                    Existing transactions in this account will not be converted.
                    Their amounts will be shown in the selected currency as they
                    are.
                  </Trans>
                </Paragraph>
                <Paragraph style={{ color: theme.pageTextSubdued }}>
                  <Trans>The currency cannot be changed once it is set.</Trans>
                </Paragraph>
                {isBlocked && (
                  <View style={{ color: theme.errorText }}>
                    <Text>
                      <Trans>
                        This account has transfers with accounts in a different
                        currency, so this currency cannot be set:
                      </Trans>
                    </Text>
                    {conflicts.map(conflict => (
                      <Text key={conflict.transactionId}>
                        {conflict.date}: {conflict.accountName} →{' '}
                        {conflict.otherAccountName}
                      </Text>
                    ))}
                  </View>
                )}
                {setCurrency.error && (
                  <Text style={{ color: theme.errorText }}>
                    {setCurrency.error.message}
                  </Text>
                )}
                <ModalButtons>
                  <Button onPress={() => state.close()}>
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button
                    variant="primary"
                    style={{ marginLeft: 10 }}
                    isDisabled={isBlocked || setCurrency.isPending}
                    onPress={() =>
                      setCurrency.mutate(
                        { id: account.id, currency },
                        { onSuccess: () => dispatch(closeModal()) },
                      )
                    }
                  >
                    <Trans>Set currency</Trans>
                  </Button>
                </ModalButtons>
              </>
            ) : (
              <>
                <Text>
                  {account.currency} –{' '}
                  {currencyTranslations.get(account.currency ?? '') ?? ''}
                </Text>
                <Paragraph style={{ color: theme.pageTextSubdued }}>
                  <Trans>
                    The currency of this account cannot be changed once set.
                  </Trans>
                </Paragraph>
                <ModalButtons>
                  <Button onPress={() => state.close()}>
                    <Trans>Close</Trans>
                  </Button>
                </ModalButtons>
              </>
            )}
          </View>
        </>
      )}
    </Modal>
  );
}
