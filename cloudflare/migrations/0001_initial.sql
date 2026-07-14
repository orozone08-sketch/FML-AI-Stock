PRAGMA foreign_keys = ON;

CREATE TABLE companies (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL COLLATE NOCASE UNIQUE,
 gst_number TEXT, allow_gst_purchase INTEGER NOT NULL DEFAULT 1 CHECK(allow_gst_purchase IN(0,1)),
 allow_cash_purchase INTEGER NOT NULL DEFAULT 0 CHECK(allow_cash_purchase IN(0,1)),
 allow_gst_sale INTEGER NOT NULL DEFAULT 1 CHECK(allow_gst_sale IN(0,1)),
 allow_cash_sale INTEGER NOT NULL DEFAULT 0 CHECK(allow_cash_sale IN(0,1)), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER, updated_by_id INTEGER
);
CREATE TABLE users (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL,
 company_id INTEGER REFERENCES companies(id), role TEXT NOT NULL CHECK(role IN('ADMIN','STOCK','SALES','ACCOUNTS','VIEWER')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), last_login_at TEXT, force_password_change INTEGER NOT NULL DEFAULT 0 CHECK(force_password_change IN(0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id)
);
CREATE TABLE permission_overrides (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, module TEXT NOT NULL,
 can_view INTEGER CHECK(can_view IN(0,1)), can_create INTEGER CHECK(can_create IN(0,1)), can_edit INTEGER CHECK(can_edit IN(0,1)),
 can_approve INTEGER CHECK(can_approve IN(0,1)), can_export INTEGER CHECK(can_export IN(0,1)), can_deactivate INTEGER CHECK(can_deactivate IN(0,1)),
 UNIQUE(user_id,module)
);
CREATE TABLE stock_books (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), name TEXT NOT NULL, code TEXT NOT NULL COLLATE NOCASE UNIQUE,
 book_type TEXT NOT NULL CHECK(book_type IN('GST','CASH')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id)
);
CREATE TABLE items (
 id INTEGER PRIMARY KEY, code TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'pcs', hsn TEXT,
 gst_basis_points INTEGER NOT NULL DEFAULT 0 CHECK(gst_basis_points BETWEEN 0 AND 10000), minimum_stock_milliunits INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id)
);
CREATE TABLE suppliers (
 id INTEGER PRIMARY KEY, code TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL, gst_number TEXT, mobile TEXT, email TEXT, address TEXT,
 default_credit_days INTEGER NOT NULL DEFAULT 30 CHECK(default_credit_days>=0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id)
);
CREATE TABLE customers (
 id INTEGER PRIMARY KEY, code TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL, contact_person TEXT,
 customer_type TEXT NOT NULL DEFAULT 'CASH_AND_BILL' CHECK(customer_type IN('CASH','BILL','CASH_AND_BILL')), gst_number TEXT, mobile TEXT, whatsapp TEXT,
 email TEXT, address TEXT, city TEXT, state TEXT, default_credit_days INTEGER NOT NULL DEFAULT 30 CHECK(default_credit_days>=0),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id)
);
CREATE TABLE payment_modes (
 id INTEGER PRIMARY KEY, code TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id)
);

CREATE TABLE opening_stocks (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), stock_book_id INTEGER NOT NULL REFERENCES stock_books(id),
 reference_number TEXT NOT NULL, opening_date TEXT NOT NULL CHECK(opening_date GLOB '????-??-??'), remarks TEXT, is_void INTEGER NOT NULL DEFAULT 0 CHECK(is_void IN(0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id),
 UNIQUE(company_id,reference_number)
);
CREATE TABLE opening_stock_lines (
 id INTEGER PRIMARY KEY, opening_stock_id INTEGER NOT NULL REFERENCES opening_stocks(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id),
 quantity_milliunits INTEGER NOT NULL CHECK(quantity_milliunits<>0), rate_ten_thousandths INTEGER NOT NULL, value_paise INTEGER NOT NULL, remarks TEXT
);
CREATE TABLE purchases (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), stock_book_id INTEGER NOT NULL REFERENCES stock_books(id), supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
 purchase_type TEXT NOT NULL CHECK(purchase_type IN('GST','CASH')), bill_number TEXT NOT NULL, bill_date TEXT NOT NULL, due_date TEXT,
 subtotal_paise INTEGER NOT NULL DEFAULT 0 CHECK(subtotal_paise>=0), gst_total_paise INTEGER NOT NULL DEFAULT 0 CHECK(gst_total_paise>=0), grand_total_paise INTEGER NOT NULL DEFAULT 0 CHECK(grand_total_paise>=0),
 paid_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount_paise>=0), balance_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(balance_amount_paise>=0),
 payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN('UNPAID','PARTIAL','PAID','ADVANCE')), remarks TEXT,
 is_opening INTEGER NOT NULL DEFAULT 0 CHECK(is_opening IN(0,1)), is_void INTEGER NOT NULL DEFAULT 0 CHECK(is_void IN(0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id), UNIQUE(company_id,supplier_id,bill_number)
);
CREATE TABLE purchase_lines (
 id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id),
 quantity_milliunits INTEGER NOT NULL CHECK(quantity_milliunits>0), rate_ten_thousandths INTEGER NOT NULL CHECK(rate_ten_thousandths>=0), gst_basis_points INTEGER NOT NULL CHECK(gst_basis_points BETWEEN 0 AND 10000),
 subtotal_paise INTEGER NOT NULL CHECK(subtotal_paise>=0), gst_amount_paise INTEGER NOT NULL CHECK(gst_amount_paise>=0), line_total_paise INTEGER NOT NULL CHECK(line_total_paise>=0)
);
CREATE TABLE sales (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), stock_book_id INTEGER NOT NULL REFERENCES stock_books(id), customer_id INTEGER NOT NULL REFERENCES customers(id),
 sale_type TEXT NOT NULL CHECK(sale_type IN('GST','CASH')), invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT,
 subtotal_paise INTEGER NOT NULL DEFAULT 0 CHECK(subtotal_paise>=0), gst_total_paise INTEGER NOT NULL DEFAULT 0 CHECK(gst_total_paise>=0), grand_total_paise INTEGER NOT NULL DEFAULT 0 CHECK(grand_total_paise>=0),
 fifo_cost_paise INTEGER NOT NULL DEFAULT 0 CHECK(fifo_cost_paise>=0), gross_profit_paise INTEGER NOT NULL DEFAULT 0,
 paid_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount_paise>=0), balance_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(balance_amount_paise>=0),
 payment_status TEXT NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN('UNPAID','PARTIAL','PAID','ADVANCE')), remarks TEXT,
 is_opening INTEGER NOT NULL DEFAULT 0 CHECK(is_opening IN(0,1)), is_void INTEGER NOT NULL DEFAULT 0 CHECK(is_void IN(0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id), UNIQUE(company_id,invoice_number)
);
CREATE TABLE sale_lines (
 id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id),
 quantity_milliunits INTEGER NOT NULL CHECK(quantity_milliunits>0), sale_rate_ten_thousandths INTEGER NOT NULL CHECK(sale_rate_ten_thousandths>=0), gst_basis_points INTEGER NOT NULL CHECK(gst_basis_points BETWEEN 0 AND 10000),
 subtotal_paise INTEGER NOT NULL CHECK(subtotal_paise>=0), gst_amount_paise INTEGER NOT NULL CHECK(gst_amount_paise>=0), line_total_paise INTEGER NOT NULL CHECK(line_total_paise>=0),
 fifo_cost_paise INTEGER NOT NULL DEFAULT 0 CHECK(fifo_cost_paise>=0), gross_profit_paise INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE inter_company_transfers (
 id INTEGER PRIMARY KEY, from_company_id INTEGER NOT NULL REFERENCES companies(id), from_stock_book_id INTEGER NOT NULL REFERENCES stock_books(id),
 to_company_id INTEGER NOT NULL REFERENCES companies(id), to_stock_book_id INTEGER NOT NULL REFERENCES stock_books(id), reference_number TEXT NOT NULL UNIQUE,
 transfer_date TEXT NOT NULL, reason TEXT, remarks TEXT, total_fifo_value_paise INTEGER NOT NULL DEFAULT 0 CHECK(total_fifo_value_paise>=0),
 mismatch_approved INTEGER NOT NULL DEFAULT 0 CHECK(mismatch_approved IN(0,1)), approval_reason TEXT, approved_by_id INTEGER REFERENCES users(id), approved_at TEXT,
 is_void INTEGER NOT NULL DEFAULT 0 CHECK(is_void IN(0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id),
 CHECK(from_company_id<>to_company_id)
);
CREATE TABLE transfer_lines (
 id INTEGER PRIMARY KEY, transfer_id INTEGER NOT NULL REFERENCES inter_company_transfers(id) ON DELETE CASCADE, item_id INTEGER NOT NULL REFERENCES items(id),
 quantity_milliunits INTEGER NOT NULL CHECK(quantity_milliunits<>0), fifo_value_paise INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE fifo_layers (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), stock_book_id INTEGER NOT NULL REFERENCES stock_books(id), item_id INTEGER NOT NULL REFERENCES items(id),
 source_type TEXT NOT NULL, source_id INTEGER NOT NULL, source_line_id INTEGER, source_reference TEXT NOT NULL, source_date TEXT NOT NULL,
 original_quantity_milliunits INTEGER NOT NULL, available_quantity_milliunits INTEGER NOT NULL,
 unit_cost_ten_thousandths INTEGER NOT NULL, original_value_paise INTEGER NOT NULL,
 available_value_paise INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN('OPEN','PARTIAL','CONSUMED')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id),
 CHECK((original_quantity_milliunits>=0 AND available_quantity_milliunits<=original_quantity_milliunits) OR original_quantity_milliunits<0)
);
CREATE TABLE fifo_consumptions (
 id INTEGER PRIMARY KEY, fifo_layer_id INTEGER NOT NULL REFERENCES fifo_layers(id), source_type TEXT NOT NULL, source_id INTEGER NOT NULL, source_line_id INTEGER,
 quantity_milliunits INTEGER NOT NULL CHECK(quantity_milliunits>0), rate_ten_thousandths INTEGER NOT NULL CHECK(rate_ten_thousandths>=0), value_paise INTEGER NOT NULL CHECK(value_paise>=0), created_at TEXT NOT NULL
);
CREATE TABLE stock_ledger_entries (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), stock_book_id INTEGER NOT NULL REFERENCES stock_books(id), item_id INTEGER NOT NULL REFERENCES items(id),
 entry_date TEXT NOT NULL, movement_type TEXT NOT NULL CHECK(movement_type IN('IN','OUT')), transaction_type TEXT NOT NULL, transaction_id INTEGER NOT NULL, reference_number TEXT NOT NULL,
 quantity_in_milliunits INTEGER NOT NULL DEFAULT 0 CHECK(quantity_in_milliunits>=0), quantity_out_milliunits INTEGER NOT NULL DEFAULT 0 CHECK(quantity_out_milliunits>=0),
 rate_ten_thousandths INTEGER NOT NULL DEFAULT 0, value_paise INTEGER NOT NULL DEFAULT 0, remarks TEXT, created_at TEXT NOT NULL,
 created_by_id INTEGER REFERENCES users(id), CHECK((quantity_in_milliunits>0 AND quantity_out_milliunits=0) OR (quantity_out_milliunits>0 AND quantity_in_milliunits=0))
);
CREATE TABLE receivables (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), stock_book_id INTEGER REFERENCES stock_books(id), customer_id INTEGER REFERENCES customers(id),
 counterparty_company_id INTEGER REFERENCES companies(id), source_type TEXT NOT NULL, source_id INTEGER NOT NULL, document_number TEXT NOT NULL, document_date TEXT NOT NULL, due_date TEXT,
 transaction_type TEXT, total_amount_paise INTEGER NOT NULL CHECK(total_amount_paise>=0), paid_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount_paise>=0),
 balance_amount_paise INTEGER NOT NULL CHECK(balance_amount_paise>=0), payment_status TEXT NOT NULL CHECK(payment_status IN('UNPAID','PARTIAL','PAID','ADVANCE')),
 remarks TEXT, is_opening INTEGER NOT NULL DEFAULT 0 CHECK(is_opening IN(0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id), CHECK((customer_id IS NULL)<>(counterparty_company_id IS NULL)),
 CHECK(paid_amount_paise+balance_amount_paise=total_amount_paise), UNIQUE(company_id,source_type,source_id)
);
CREATE TABLE payables (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), stock_book_id INTEGER REFERENCES stock_books(id), supplier_id INTEGER REFERENCES suppliers(id),
 counterparty_company_id INTEGER REFERENCES companies(id), source_type TEXT NOT NULL, source_id INTEGER NOT NULL, document_number TEXT NOT NULL, document_date TEXT NOT NULL, due_date TEXT,
 transaction_type TEXT, total_amount_paise INTEGER NOT NULL CHECK(total_amount_paise>=0), paid_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount_paise>=0),
 balance_amount_paise INTEGER NOT NULL CHECK(balance_amount_paise>=0), payment_status TEXT NOT NULL CHECK(payment_status IN('UNPAID','PARTIAL','PAID','ADVANCE')),
 remarks TEXT, is_opening INTEGER NOT NULL DEFAULT 0 CHECK(is_opening IN(0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id), CHECK((supplier_id IS NULL)<>(counterparty_company_id IS NULL)),
 CHECK(paid_amount_paise+balance_amount_paise=total_amount_paise), UNIQUE(company_id,source_type,source_id)
);
CREATE TABLE payments (
 id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), payment_type TEXT NOT NULL CHECK(payment_type IN('CUSTOMER_RECEIPT','SUPPLIER_PAYMENT','OPENING_ADVANCE_RECEIVED','OPENING_ADVANCE_PAID')),
 party_type TEXT NOT NULL CHECK(party_type IN('CUSTOMER','SUPPLIER')), customer_id INTEGER REFERENCES customers(id), supplier_id INTEGER REFERENCES suppliers(id), payment_date TEXT NOT NULL,
 mode TEXT NOT NULL, reference_number TEXT, total_amount_paise INTEGER NOT NULL CHECK(total_amount_paise>0), allocated_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(allocated_amount_paise>=0),
 unallocated_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(unallocated_amount_paise>=0), remarks TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id), CHECK((customer_id IS NULL)<>(supplier_id IS NULL)),
 CHECK(allocated_amount_paise+unallocated_amount_paise=total_amount_paise)
);
CREATE TABLE payment_allocations (
 id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE, target_type TEXT NOT NULL CHECK(target_type IN('RECEIVABLE','PAYABLE')),
 target_id INTEGER NOT NULL, amount_paise INTEGER NOT NULL CHECK(amount_paise>0), created_at TEXT NOT NULL, UNIQUE(payment_id,target_type,target_id)
);
CREATE TABLE inter_company_ledger_entries (
 id INTEGER PRIMARY KEY, stock_owner_company_id INTEGER NOT NULL REFERENCES companies(id), stock_user_company_id INTEGER NOT NULL REFERENCES companies(id),
 transfer_id INTEGER NOT NULL REFERENCES inter_company_transfers(id), item_id INTEGER REFERENCES items(id), quantity_milliunits INTEGER NOT NULL DEFAULT 0,
 amount_owed_paise INTEGER NOT NULL, settled_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK(settled_amount_paise>=0),
 balance_amount_paise INTEGER NOT NULL, due_date TEXT, status TEXT NOT NULL CHECK(status IN('PENDING','RETURNED')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_id INTEGER REFERENCES users(id), updated_by_id INTEGER REFERENCES users(id),
 CHECK(stock_owner_company_id<>stock_user_company_id),
 CHECK((status='PENDING' AND amount_owed_paise>=0 AND balance_amount_paise>=0 AND settled_amount_paise+balance_amount_paise=amount_owed_paise)
    OR (status='RETURNED' AND amount_owed_paise<=0 AND balance_amount_paise=0 AND settled_amount_paise=0))
);
CREATE TABLE audit_logs (
 id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, reference TEXT,
 before_values TEXT CHECK(before_values IS NULL OR json_valid(before_values)), after_values TEXT CHECK(after_values IS NULL OR json_valid(after_values)), approval_reason TEXT,
 ip_address TEXT, user_agent TEXT, created_at TEXT NOT NULL
);
CREATE TABLE alerts (
 id INTEGER PRIMARY KEY, alert_type TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN('INFO','WARNING','CRITICAL')), company_id INTEGER REFERENCES companies(id),
 stock_book_id INTEGER REFERENCES stock_books(id), item_id INTEGER REFERENCES items(id), message TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN(0,1)), created_at TEXT NOT NULL
);
