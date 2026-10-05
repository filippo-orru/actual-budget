import { describe, expect, it } from 'vitest';

import { budgetRoutes, canonicalizeLegacyBudgetPath } from './budget-routes';

describe('budgetRoutes', () => {
  it('builds canonical budget-owned routes with encoded identifiers', () => {
    expect(budgetRoutes.budget('budget a')).toBe('/budgets/budget%20a/budget');
    expect(budgetRoutes.account('budget-a', 'account/1')).toBe(
      '/budgets/budget-a/accounts/account%2F1',
    );
    expect(budgetRoutes.reports('budget-a', 'net-worth/widget-1')).toBe(
      '/budgets/budget-a/reports/net-worth/widget-1',
    );
  });

  it('canonicalizes existing short in-app destinations', () => {
    expect(
      canonicalizeLegacyBudgetPath('/accounts/account-1', 'budget-a'),
    ).toBe('/budgets/budget-a/accounts/account-1');
    expect(canonicalizeLegacyBudgetPath('/reports/net-worth', 'budget-a')).toBe(
      '/budgets/budget-a/reports/net-worth',
    );
    expect(canonicalizeLegacyBudgetPath('/settings', 'budget-a')).toBeNull();
  });
});
