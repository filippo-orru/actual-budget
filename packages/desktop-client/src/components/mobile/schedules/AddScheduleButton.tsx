import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgAdd } from '@actual-app/components/icons/v1';

import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { useNavigate } from '#hooks/useNavigate';
import { budgetRoutes } from '#util/budget-routes';

export function AddScheduleButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const budgetId = useBudgetSpaceId();

  const handleAddSchedule = useCallback(() => {
    void navigate(budgetRoutes.schedules(budgetId, 'new'));
  }, [budgetId, navigate]);

  return (
    <Button
      variant="bare"
      aria-label={t('Add new schedule')}
      style={{ margin: 10 }}
      onPress={handleAddSchedule}
    >
      <SvgAdd width={20} height={20} />
    </Button>
  );
}
