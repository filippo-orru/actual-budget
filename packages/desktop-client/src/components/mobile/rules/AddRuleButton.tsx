import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { Button } from '@actual-app/components/button';
import { SvgAdd } from '@actual-app/components/icons/v1';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { useNavigate } from '#hooks/useNavigate';
import { budgetRoutes } from '#util/budget-routes';

export function AddRuleButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const budgetId = useBudgetSpaceId();
  const location = useLocation();

  const handleAddRule = useCallback(() => {
    // Carry the rules list filter so it is restored when coming back.
    void navigate(`${budgetRoutes.rules(budgetId, 'new')}${location.search}`);
  }, [budgetId, navigate, location.search]);

  return (
    <Button
      variant="bare"
      aria-label={t('Add new rule')}
      style={{ margin: 10 }}
      onPress={handleAddRule}
    >
      <SvgAdd width={20} height={20} />
    </Button>
  );
}
