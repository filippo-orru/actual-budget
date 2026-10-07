import { describe, expect, it } from 'vitest';

import { budgetRoutes, canonicalizeLegacyBudgetPath } from './budget-routes';

describe('budgetRoutes', () => {
  it('builds canonical routes with encoded identifiers', () => {
    expect(budgetRoutes.budget('budget a')).toBe('/spaces/budget%20a/budget');
    expect(budgetRoutes.account('budget-a', 'account/1')).toBe(
      '/spaces/budget-a/accounts/account%2F1',
    );
    expect(budgetRoutes.reports('budget-a', 'net-worth/widget-1')).toBe(
      '/spaces/budget-a/reports/net-worth/widget-1',
    );
    expect(budgetRoutes.payees()).toBe('/payees');
    expect(budgetRoutes.payees('payee/1')).toBe('/payees/payee%2F1');
    expect(budgetRoutes.tags()).toBe('/tags');
  });

  it('canonicalizes existing short in-app destinations', () => {
    expect(
      canonicalizeLegacyBudgetPath('/accounts/account-1', 'budget-a'),
    ).toBe('/spaces/budget-a/accounts/account-1');
    expect(canonicalizeLegacyBudgetPath('/reports/net-worth', 'budget-a')).toBe(
      '/spaces/budget-a/reports/net-worth',
    );
    expect(canonicalizeLegacyBudgetPath('/settings', 'budget-a')).toBeNull();
    expect(canonicalizeLegacyBudgetPath('/payees', 'budget-a')).toBeNull();
    expect(
      canonicalizeLegacyBudgetPath('/payees/payee-1', 'budget-a'),
    ).toBeNull();
    expect(canonicalizeLegacyBudgetPath('/tags', 'budget-a')).toBeNull();
  });
});
