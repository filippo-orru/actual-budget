import { useTranslation } from 'react-i18next';

import type { AccountEntity } from '@actual-app/core/types/models';

import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

import { useCurrencyFeature } from './useCurrencyFeature';

/**
 * Context menu items for editing an account's currency. Empty unless the
 * currency feature is active and the account is off-budget.
 */
export function useEditAccountCurrencyMenuItem(account?: AccountEntity) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { isCurrencyActive } = useCurrencyFeature();

  if (!account || !isCurrencyActive || !account.offbudget) {
    return [];
  }

  return [
    {
      name: 'account-currency',
      text: t('Edit currency'),
      onClick: () =>
        dispatch(
          pushModal({
            modal: { name: 'edit-account-currency', options: { account } },
          }),
        ),
    },
  ];
}
