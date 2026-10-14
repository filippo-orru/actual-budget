ALTER TABLE zero_budgets ADD COLUMN tombstone INTEGER DEFAULT 0;
ALTER TABLE reflect_budgets ADD COLUMN tombstone INTEGER DEFAULT 0;
ALTER TABLE zero_budget_months ADD COLUMN tombstone INTEGER DEFAULT 0;
