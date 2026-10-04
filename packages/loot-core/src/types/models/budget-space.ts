export type BudgetSpaceEntity = {
  id: string;
  name: string;
  currency_code: string;
  budget_type: 'envelope' | 'tracking';
  sort_order: number;
  tombstone: boolean;
};
