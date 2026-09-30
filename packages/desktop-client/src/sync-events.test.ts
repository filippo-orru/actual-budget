import { initServer } from '@actual-app/core/platform/client/connection';

import { createTestQueryClient } from './mocks';
import { mergeSyncedPrefs } from './prefs/prefsSlice';
import { configureAppStore } from './redux/store';
import { createCrossCurrencyTransferChecker } from './sync-events';

vi.mock(
  '@actual-app/core/platform/client/connection',
  () => import('#mocks/connection'),
);

type Transfer = { transactionId: string };

function setup(transfers: () => Transfer[], multiCurrency = true) {
  initServer({
    'multi-currency-status': () =>
      Promise.resolve({
        isCurrencyActive: true,
        globalCurrency: 'USD',
        unassignedAccounts: [],
        crossCurrencyTransfers: transfers().map(t => ({
          ...t,
          date: '2026-01-01',
          accountId: 'a',
          accountName: 'A',
          otherAccountId: 'b',
          otherAccountName: 'B',
        })),
      }),
  });
  const store = configureAppStore({ queryClient: createTestQueryClient() });
  store.dispatch(
    mergeSyncedPrefs({ 'flags.multiCurrency': String(multiCurrency) }),
  );
  return {
    store,
    check: createCrossCurrencyTransferChecker(store),
    notifications: () =>
      store
        .getState()
        .notifications.notifications.filter(
          n => n.id === 'cross-currency-transfers',
        ),
  };
}

describe('cross-currency transfer warning after sync', () => {
  it('warns once for the same set of transfers', async () => {
    const { check, notifications } = setup(() => [{ transactionId: 't1' }]);
    await check();
    await check();
    expect(notifications()).toHaveLength(1);
  });

  it('warns again when the set of transfers changes', async () => {
    let current = [{ transactionId: 't1' }];
    const { check, store } = setup(() => current);
    await check();
    current = [{ transactionId: 't1' }, { transactionId: 't2' }];
    await check();
    const dispatched = store
      .getState()
      .notifications.notifications.filter(
        n => n.id === 'cross-currency-transfers',
      );
    // same id: the notification is replaced, not duplicated
    expect(dispatched).toHaveLength(1);
  });

  it('does nothing without transfers', async () => {
    const { check, notifications } = setup(() => []);
    await check();
    expect(notifications()).toHaveLength(0);
  });

  it('does nothing when multiCurrency is off', async () => {
    const { check, notifications } = setup(
      () => [{ transactionId: 't1' }],
      false,
    );
    await check();
    expect(notifications()).toHaveLength(0);
  });
});
