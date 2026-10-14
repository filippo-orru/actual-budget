import type { ReactNode } from 'react';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTestQueryClient,
  resetTestProviders,
  TestProviders,
} from '#mocks';

import { DeleteBudgetSpaceModal } from './BudgetSpaceModals';

const { mockSend, mockNavigate, mockClose } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockNavigate: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('@actual-app/core/platform/client/connection', () => ({
  send: mockSend,
}));

vi.mock('#hooks/useNavigate', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('#hooks/useMetadataPref', () => ({
  useMetadataPref: () => ['file-id'],
}));

vi.mock('#hooks/useFormat', () => ({
  useFormat: () => (amount: number) => `$${(amount / 100).toFixed(2)}`,
}));

vi.mock('#components/CurrencyProvider', () => ({
  CurrencyProvider: ({
    currencyCode,
    children,
  }: {
    currencyCode: string;
    children: ReactNode;
  }) => <span data-currency={currencyCode}>{children}</span>,
}));

vi.mock('#components/common/Modal', () => ({
  Modal: ({
    children,
  }: {
    children: (props: { state: { close: () => void } }) => ReactNode;
  }) => children({ state: { close: mockClose } }),
  ModalCloseButton: ({ onPress }: { onPress: () => void }) => (
    <button onClick={onPress}>Close</button>
  ),
  ModalHeader: ({ title }: { title: ReactNode }) => <h1>{title}</h1>,
}));

describe('DeleteBudgetSpaceModal', () => {
  beforeEach(() => {
    resetTestProviders();
    vi.clearAllMocks();
    mockSend.mockImplementation(async (method: string) => {
      if (method === 'accounts-get') {
        return [{ id: 'checking', name: 'Checking' }];
      }
      if (method === 'account-properties') {
        return { balance: 1234 };
      }
      if (method === 'budget-spaces/get') {
        return [
          {
            id: 'remaining-space',
            name: 'Main',
            currency_code: 'USD',
            budget_type: 'envelope',
            sort_order: 0,
            tombstone: false,
          },
        ];
      }
      return undefined;
    });
  });

  function renderModal() {
    const queryClient = createTestQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestProviders queryClient={queryClient}>{children}</TestProviders>
    );
    render(
      <DeleteBudgetSpaceModal
        budgetId="budget-to-delete"
        budgetName="Travel"
        currencyCode="USD"
      />,
      { wrapper },
    );
    return queryClient;
  }

  it('shows account balances in the budget currency and requires the exact confirmation word', async () => {
    const user = userEvent.setup();
    const queryClient = renderModal();
    const spacesQueryKey = ['budget-spaces', 'file-id', 'list'];
    mockNavigate.mockImplementation(() => {
      expect(queryClient.getQueryData(spacesQueryKey)).toBeUndefined();
    });

    const accountRow = await screen.findByRole('listitem');
    expect(accountRow).toHaveTextContent('Checking: $12.34');
    expect(accountRow.querySelector('[data-currency="USD"]')).not.toBeNull();

    const deleteButton = screen.getByRole('button', {
      name: 'Delete budget space',
    });
    expect(deleteButton).toBeDisabled();

    const confirmationInput = screen.getByRole('textbox', {
      name: 'Type "delete" to confirm',
    });
    await user.type(confirmationInput, 'Delete');
    expect(deleteButton).toBeDisabled();
    expect(mockSend).not.toHaveBeenCalledWith('budget-spaces/delete', {
      id: 'budget-to-delete',
    });

    await user.clear(confirmationInput);
    await user.type(confirmationInput, 'delete');
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith('budget-spaces/delete', {
        id: 'budget-to-delete',
      });
    });
    expect(mockSend).toHaveBeenCalledWith('budget-spaces/get');
    expect(queryClient.getQueryData(spacesQueryKey)).toEqual([
      {
        id: 'remaining-space',
        name: 'Main',
        currency_code: 'USD',
        budget_type: 'envelope',
        sort_order: 0,
        tombstone: false,
      },
    ]);
    expect(mockNavigate).toHaveBeenCalledWith('/spaces');
  });
});
