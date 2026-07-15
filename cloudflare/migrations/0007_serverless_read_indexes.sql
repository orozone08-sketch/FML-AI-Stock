PRAGMA foreign_keys = ON;

-- Party profiles always start with party ID. These party-first indexes cover
-- all-company administrators without scans. Existing company-first indexes
-- remain optimal for fixed-company logins and company-wide reports.
CREATE INDEX idx_sales_customer_profile
  ON sales(customer_id,invoice_date DESC,id DESC,company_id)
  WHERE is_void=0;
CREATE INDEX idx_receivables_customer_profile
  ON receivables(customer_id,company_id,document_date DESC,id DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX idx_payments_customer_profile
  ON payments(customer_id,payment_date DESC,id DESC,company_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX idx_purchases_supplier_profile
  ON purchases(supplier_id,bill_date DESC,id DESC,company_id)
  WHERE is_void=0;
CREATE INDEX idx_payables_supplier_profile
  ON payables(supplier_id,company_id,document_date DESC,id DESC)
  WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_payments_supplier_profile
  ON payments(supplier_id,payment_date DESC,id DESC,company_id)
  WHERE supplier_id IS NOT NULL;

-- SQLite does not create indexes for foreign keys. Parent-key indexes avoid a
-- growing child-table scan in profile, print, edit, void, and delete paths.
CREATE INDEX idx_opening_stock_lines_opening
  ON opening_stock_lines(opening_stock_id,id);
CREATE INDEX idx_purchase_lines_purchase
  ON purchase_lines(purchase_id,id);
CREATE INDEX idx_sale_lines_sale
  ON sale_lines(sale_id,id);
CREATE INDEX idx_transfer_lines_transfer
  ON transfer_lines(transfer_id,id);
