CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  currency_code TEXT NOT NULL DEFAULT '',
  budget_type TEXT NOT NULL DEFAULT 'envelope',
  sort_order INTEGER NOT NULL DEFAULT 0,
  tombstone INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO budgets (id, name, currency_code, budget_type, sort_order, tombstone)
SELECT
  'default',
  'Main',
  COALESCE((SELECT value FROM preferences WHERE id = 'defaultCurrencyCode'), ''),
  COALESCE((SELECT value FROM preferences WHERE id = 'budgetType'), 'envelope'),
  0,
  0;

ALTER TABLE accounts ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE account_groups ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE categories ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE category_groups ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE cleanup_groups ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE rules ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE schedules ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE transaction_filters ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE custom_reports ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE dashboard_pages ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE zero_budgets ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE reflect_budgets ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE zero_budget_months ADD COLUMN budget_id TEXT DEFAULT 'default';
ALTER TABLE zero_budget_months ADD COLUMN month TEXT;
UPDATE zero_budget_months SET month = id WHERE month IS NULL;

CREATE INDEX accounts_budget_id_idx ON accounts (budget_id);
CREATE INDEX account_groups_budget_id_idx ON account_groups (budget_id);
CREATE INDEX categories_budget_id_idx ON categories (budget_id);
CREATE INDEX category_groups_budget_id_idx ON category_groups (budget_id);
CREATE INDEX rules_budget_id_idx ON rules (budget_id);
CREATE INDEX schedules_budget_id_idx ON schedules (budget_id);
CREATE INDEX transaction_filters_budget_id_idx ON transaction_filters (budget_id);
CREATE INDEX custom_reports_budget_id_idx ON custom_reports (budget_id);
CREATE INDEX dashboard_pages_budget_id_idx ON dashboard_pages (budget_id);
CREATE INDEX zero_budgets_budget_id_idx ON zero_budgets (budget_id);
CREATE INDEX reflect_budgets_budget_id_idx ON reflect_budgets (budget_id);
CREATE INDEX zero_budget_months_budget_month_idx ON zero_budget_months (budget_id, month);
