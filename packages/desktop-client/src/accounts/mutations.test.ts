import { send } from '@actual-app/core/platform/client/connection';
import type { AccountEntity } from '@actual-app/core/types/models';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { useUpdateAccountMutation } from './mutations';

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(send).mockResolvedValue({});
});

describe('useUpdateAccountMutation', () => {
  it('excludes ownership fields when reconciling a full account object', async () => {
    const account: Pick<AccountEntity, 'id'> & Partial<AccountEntity> = {
      id: 'migrated-account',
      budget_id: 'destination-budget',
      name: 'Checking',
      offbudget: 0,
      closed: 0,
      sort_order: 1000,
      last_reconciled: '1735689600000',
      account_group_id: null,
    };
    const { result } = renderHook(() => useUpdateAccountMutation(), {
      wrapper: TestProviders,
    });

    await act(async () => {
      await result.current.mutateAsync({ account });
    });

    expect(send).toHaveBeenCalledExactlyOnceWith('account-update', {
      id: account.id,
      name: account.name,
      last_reconciled: account.last_reconciled,
      account_group_id: null,
    });
    expect(account.budget_id).toBe('destination-budget');
  });

  it('preserves partial updates without adding unrelated fields', async () => {
    const { result } = renderHook(() => useUpdateAccountMutation(), {
      wrapper: TestProviders,
    });

    await act(async () => {
      await result.current.mutateAsync({
        account: { id: 'account', name: 'Renamed' },
      });
    });

    expect(send).toHaveBeenCalledExactlyOnceWith('account-update', {
      id: 'account',
      name: 'Renamed',
    });
  });

  it('preserves account group assignments', async () => {
    const { result } = renderHook(() => useUpdateAccountMutation(), {
      wrapper: TestProviders,
    });

    await act(async () => {
      await result.current.mutateAsync({
        account: { id: 'account', account_group_id: 'group' },
      });
    });

    expect(send).toHaveBeenCalledExactlyOnceWith('account-update', {
      id: 'account',
      account_group_id: 'group',
    });
  });
});
