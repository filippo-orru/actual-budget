import { useCallback } from 'react';

import { send } from '@actual-app/core/platform/client/connection';
import { currencies } from '@actual-app/core/shared/currencies';
import { useQueryClient } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

function hasKnownCurrency(currencyCode: string | null | undefined) {
  return (
    !!currencyCode &&
    currencies.some(currency => currency.code === currencyCode)
  );
}

/**
 * Opens the "Create budget space" modal, or the "Choose a currency first"
 * modal when an existing budget space has no known currency yet.
 */
export function useOpenCreateBudgetSpace() {
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const [fileId] = useMetadataPref('id');

  return useCallback(async () => {
    const spaces = await send('budget-spaces/get');
    queryClient.setQueryData(budgetSpaceQueries.list(fileId).queryKey, spaces);

    const activeSpaces = spaces.filter(space => !space.tombstone);
    const spaceWithoutCurrency = activeSpaces.find(
      space => !hasKnownCurrency(space.currency_code),
    );

    if (spaceWithoutCurrency) {
      dispatch(
        pushModal({
          modal: {
            name: 'budget-space-currency-required',
            options: {
              budgetId: spaceWithoutCurrency.id,
              budgetName: spaceWithoutCurrency.name,
            },
          },
        }),
      );
      return;
    }

    dispatch(
      pushModal({
        modal: {
          name: 'budget-space-create',
          options: {
            defaultCurrencyCode: activeSpaces[0]?.currency_code ?? '',
          },
        },
      }),
    );
  }, [dispatch, queryClient, fileId]);
}
