import React, { useState } from 'react';
import { Trans } from 'react-i18next';

import { ButtonWithLoading } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { send } from '@actual-app/core/platform/client/connection';
import { useQueryClient } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { Link } from '#components/common/Link';
import { useBudgetSpace } from '#hooks/useBudgetSpace';

import { Setting } from './UI';

export function BudgetTypeSettings() {
  const budgetSpace = useBudgetSpace();
  const queryClient = useQueryClient();
  const budgetType = budgetSpace.budget_type;
  const [isLoading, setIsLoading] = useState(false);

  async function onSwitchType() {
    setIsLoading(true);
    try {
      const newBudgetType = budgetType === 'envelope' ? 'tracking' : 'envelope';
      await send('budget-spaces/update', {
        id: budgetSpace.id,
        budgetType: newBudgetType,
      });
      await queryClient.invalidateQueries({
        queryKey: budgetSpaceQueries.all(),
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Setting
      primaryAction={
        <ButtonWithLoading onPress={onSwitchType} isLoading={isLoading}>
          {budgetType === 'tracking' ? (
            <Trans>Switch to envelope budgeting</Trans>
          ) : (
            <Trans>Switch to tracking budgeting</Trans>
          )}
        </ButtonWithLoading>
      }
    >
      <Text>
        <Trans>
          <strong>Envelope budgeting</strong> (recommended) digitally mimics
          physical envelope budgeting system by allocating funds into virtual
          envelopes for different expenses. It helps track spending and ensure
          you don't overspend in any category.
        </Trans>{' '}
        <Link
          variant="external"
          to="https://actualbudget.org/docs/getting-started/envelope-budgeting"
          linkColor="purple"
        >
          <Trans>Learn more</Trans>
        </Link>
      </Text>
      <Text>
        <Trans>
          With <strong>tracking budgeting</strong>, category balances reset each
          month, and funds are managed using a "Saved" metric instead of "To Be
          Budgeted." Income is forecasted to plan future spending, rather than
          relying on current available funds.
        </Trans>{' '}
        <Link
          variant="external"
          to="https://actualbudget.org/docs/getting-started/tracking-budget"
          linkColor="purple"
        >
          <Trans>Learn more</Trans>
        </Link>
      </Text>
    </Setting>
  );
}
