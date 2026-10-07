import type { ComponentPropsWithoutRef, CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { Menu } from '@actual-app/components/menu';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { useQuery } from '@tanstack/react-query';

import { budgetSpaceQueries } from '#budget-spaces/queries';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { useBudgetSpaceId } from '#hooks/useBudgetSpace';
import { useLocalPref } from '#hooks/useLocalPref';
import { useMetadataPref } from '#hooks/useMetadataPref';
import { useNavigate } from '#hooks/useNavigate';
import type { Modal as ModalType } from '#modals/modalsSlice';
import { budgetRoutes } from '#util/budget-routes';

type BudgetPageMenuModalProps = Extract<
  ModalType,
  { name: 'budget-page-menu' }
>['options'];

export function BudgetPageMenuModal({
  onAddCategoryGroup,
  onToggleHiddenCategories,
  onSwitchBudgetFile,
}: BudgetPageMenuModalProps) {
  const defaultMenuItemStyle: CSSProperties = {
    ...styles.mobileMenuItem,
    color: theme.menuItemText,
    borderRadius: 0,
    borderTop: `1px solid ${theme.pillBorder}`,
  };

  return (
    <Modal name="budget-page-menu">
      {({ state }) => (
        <>
          <ModalHeader
            showLogo
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <BudgetPageMenu
            getItemStyle={() => defaultMenuItemStyle}
            onAddCategoryGroup={onAddCategoryGroup}
            onToggleHiddenCategories={onToggleHiddenCategories}
            onSwitchBudgetFile={onSwitchBudgetFile}
          />
          <BudgetSpaceSwitcher />
        </>
      )}
    </Modal>
  );
}

type BudgetPageMenuProps = Omit<
  ComponentPropsWithoutRef<typeof Menu>,
  'onMenuSelect' | 'items'
> & {
  onAddCategoryGroup: () => void;
  onToggleHiddenCategories: () => void;
  onSwitchBudgetFile: () => void;
};

function BudgetSpaceSwitcher() {
  const { t } = useTranslation();
  const [fileId] = useMetadataPref('id');
  const { data: budgetSpaces = [] } = useQuery(budgetSpaceQueries.list(fileId));
  const activeBudgetSpaces = budgetSpaces.filter(space => !space.tombstone);
  const budgetId = useBudgetSpaceId();
  const navigate = useNavigate();

  return (
    <select
      aria-label={t('Switch budget space')}
      value={budgetId}
      onChange={event => void navigate(budgetRoutes.budget(event.target.value))}
      style={{
        ...styles.mobileMenuItem,
        padding: '8px 10px',
        width: '100%',
        color: theme.menuItemText,
        backgroundColor: 'transparent',
        border: 0,
        borderRadius: 0,
        borderTop: `1px solid ${theme.pillBorder}`,
        textAlign: 'left',
      }}
    >
      {activeBudgetSpaces.map(space => (
        <option key={space.id} value={space.id}>
          Budget Space: {space.name}
        </option>
      ))}
    </select>
  );
}

function BudgetPageMenu({
  onAddCategoryGroup,
  onToggleHiddenCategories,
  onSwitchBudgetFile,
  ...props
}: BudgetPageMenuProps) {
  const [showHiddenCategories] = useLocalPref('budget.showHiddenCategories');

  const onMenuSelect = (name: string) => {
    switch (name) {
      case 'add-category-group':
        onAddCategoryGroup?.();
        break;
      // case 'edit-mode':
      //   onEditMode?.(true);
      //   break;
      case 'toggle-hidden-categories':
        onToggleHiddenCategories?.();
        break;
      case 'switch-budget-file':
        onSwitchBudgetFile?.();
        break;
      default:
        throw new Error(`Unrecognized menu item: ${name}`);
    }
  };
  const { t } = useTranslation();

  return (
    <Menu
      {...props}
      onMenuSelect={onMenuSelect}
      items={[
        {
          name: 'add-category-group',
          text: t('Add category group'),
        },
        {
          name: 'toggle-hidden-categories',
          text: `${!showHiddenCategories ? t('Show hidden categories') : t('Hide hidden categories')}`,
        },
        {
          name: 'switch-budget-file',
          text: t('Switch budget file'),
        },
      ]}
    />
  );
}
