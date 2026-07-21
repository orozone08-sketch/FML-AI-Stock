PRAGMA foreign_keys = ON;

-- All-company dashboard/report reads cannot use company-leading indexes.
-- Partial indexes keep the hot working sets small without indexing void/settled rows.
CREATE INDEX idx_sales_active_date
  ON sales(invoice_date DESC,id DESC) WHERE is_void=0;
CREATE INDEX idx_purchases_active_date
  ON purchases(bill_date DESC,id DESC) WHERE is_void=0;
CREATE INDEX idx_receivables_open_due_all
  ON receivables(due_date,id) WHERE balance_amount_paise>0;
CREATE INDEX idx_payables_open_due_all
  ON payables(due_date,id) WHERE balance_amount_paise>0;
CREATE INDEX idx_inter_company_pending_due_all
  ON inter_company_ledger_entries(due_date,id) WHERE status='PENDING';
