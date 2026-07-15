PRAGMA foreign_keys = ON;
CREATE TABLE inventory_balances (
 company_id INTEGER NOT NULL REFERENCES companies(id), stock_book_id INTEGER NOT NULL REFERENCES stock_books(id), item_id INTEGER NOT NULL REFERENCES items(id),
 quantity_milliunits INTEGER NOT NULL DEFAULT 0, ledger_value_paise INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), updated_at TEXT NOT NULL,
 PRIMARY KEY(company_id,stock_book_id,item_id)
) WITHOUT ROWID;
CREATE TABLE data_versions (
 namespace TEXT NOT NULL, company_id INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), updated_at TEXT NOT NULL,
 PRIMARY KEY(namespace,company_id)
) WITHOUT ROWID;
CREATE INDEX idx_users_company_active ON users(company_id,active,name,id);
CREATE INDEX idx_permission_overrides_user ON permission_overrides(user_id,module);
CREATE INDEX idx_stock_books_company_active ON stock_books(company_id,active,name,id);
CREATE INDEX idx_opening_stocks_company_date ON opening_stocks(company_id,opening_date DESC,id DESC);
CREATE INDEX idx_purchases_company_date ON purchases(company_id,bill_date DESC,id DESC);
CREATE INDEX idx_purchases_supplier_date ON purchases(company_id,supplier_id,bill_date DESC,id DESC);
CREATE INDEX idx_sales_company_date ON sales(company_id,invoice_date DESC,id DESC);
CREATE INDEX idx_sales_customer_date ON sales(company_id,customer_id,invoice_date DESC,id DESC);
CREATE INDEX idx_transfers_from_date ON inter_company_transfers(from_company_id,transfer_date DESC,id DESC);
CREATE INDEX idx_transfers_to_date ON inter_company_transfers(to_company_id,transfer_date DESC,id DESC);
CREATE INDEX idx_fifo_active ON fifo_layers(company_id,stock_book_id,item_id,source_date,id) WHERE available_quantity_milliunits>0 AND status='OPEN';
CREATE INDEX idx_fifo_source ON fifo_layers(source_type,source_id,source_line_id);
CREATE INDEX idx_fifo_consumptions_source ON fifo_consumptions(source_type,source_id,source_line_id);
CREATE INDEX idx_fifo_consumptions_layer ON fifo_consumptions(fifo_layer_id,id);
CREATE INDEX idx_stock_ledger_item_date ON stock_ledger_entries(company_id,stock_book_id,item_id,entry_date,id);
CREATE INDEX idx_stock_ledger_source ON stock_ledger_entries(transaction_type,transaction_id,id);
CREATE INDEX idx_receivables_open ON receivables(company_id,customer_id,due_date,document_date,id) WHERE balance_amount_paise>0;
CREATE INDEX idx_payables_open ON payables(company_id,supplier_id,due_date,document_date,id) WHERE balance_amount_paise>0;
CREATE INDEX idx_payments_customer_date ON payments(company_id,customer_id,payment_date DESC,id DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_payments_supplier_date ON payments(company_id,supplier_id,payment_date DESC,id DESC) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_payment_allocations_target ON payment_allocations(target_type,target_id,payment_id);
CREATE INDEX idx_inter_company_ledger_open ON inter_company_ledger_entries(stock_owner_company_id,stock_user_company_id,status,due_date,id);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC,id DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type,entity_id,created_at DESC,id DESC);
CREATE INDEX idx_audit_user ON audit_logs(user_id,created_at DESC,id DESC);
CREATE INDEX idx_alerts_unresolved ON alerts(company_id,severity,created_at DESC,id DESC) WHERE resolved=0;
