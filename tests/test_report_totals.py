from app.extensions import db
from app.models import Customer, Payment, Receivable, StockLedgerEntry
from app.services.payments import create_customer_receipt
from app.services.transactions import create_opening_receivable, create_purchase, create_sale
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login


def test_sales_report_displays_money_totals(client, app):
    with app.app_context():
        data = ids()
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "REPORT-TOTAL-INV",
                "invoice_date": "2026-06-23",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()

    login(client)
    response = client.get("/reports/sales")

    assert response.status_code == 200
    assert b"Shown rows total" in response.data
    assert b"Grand total" in response.data
    assert "₹118.00".encode() in response.data


def test_monthly_sales_and_purchase_reports(client, app):
    with app.app_context():
        data = ids()
        for number, rate in [("MONTH-SALE-1", "100"), ("MONTH-SALE-2", "200")]:
            create_sale(
                {
                    "company_id": data["ai"].id,
                    "stock_book_id": data["ai_gst"].id,
                    "customer_id": data["customer"].id,
                    "sale_type": "GST",
                    "invoice_number": number,
                    "invoice_date": "2026-06-23",
                },
                [{"item_id": data["item"].id, "quantity": "1", "rate": rate, "gst_percent": "0"}],
                admin(),
            )
        for number, rate in [("MONTH-PUR-1", "50"), ("MONTH-PUR-2", "150")]:
            create_purchase(
                {
                    "company_id": data["ai"].id,
                    "stock_book_id": data["ai_gst"].id,
                    "supplier_id": data["supplier"].id,
                    "purchase_type": "GST",
                    "bill_number": number,
                    "bill_date": "2026-06-24",
                },
                [{"item_id": data["item"].id, "quantity": "1", "rate": rate, "gst_percent": "0"}],
                admin(),
            )
        db.session.commit()

    login(client)
    sales = client.get("/reports/sales-monthly")
    purchases = client.get("/reports/purchases-monthly")

    assert sales.status_code == 200
    assert b"Monthly Sales Report" in sales.data
    assert b"2026-06" in sales.data
    assert "₹300.00".encode() in sales.data
    assert purchases.status_code == 200
    assert b"Monthly Purchase Report" in purchases.data
    assert b"2026-06" in purchases.data
    assert "₹200.00".encode() in purchases.data


def test_outstanding_customer_search_shows_filtered_balance_summary(client, app):
    with app.app_context():
        data = ids()
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "CUSTOMER-OUTSTANDING-INV",
                "invoice_date": "2026-06-23",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "250", "gst_percent": "18"}],
            admin(),
        )
        customer_name = data["customer"].name
        db.session.commit()

    login(client)
    response = client.get(f"/finance/outstanding?q={customer_name.swapcase()}")

    assert response.status_code == 200
    assert b"Customer Balance" in response.data
    assert "₹295.00".encode() in response.data
    assert b"CUSTOMER-OUTSTANDING-INV" in response.data


def test_outstanding_page_groups_customer_once_per_company(client, app):
    with app.app_context():
        data = ids()
        for number, rate in [("PAGE-GROUP-CUST-1", "100"), ("PAGE-GROUP-CUST-2", "200")]:
            create_sale(
                {
                    "company_id": data["ai"].id,
                    "stock_book_id": data["ai_gst"].id,
                    "customer_id": data["customer"].id,
                    "sale_type": "GST",
                    "invoice_number": number,
                    "invoice_date": "2026-06-23",
                },
                [{"item_id": data["item"].id, "quantity": "1", "rate": rate, "gst_percent": "18"}],
                admin(),
            )
        customer_name = data["customer"].name
        db.session.commit()

    login(client)
    response = client.get("/finance/outstanding")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert html.count(customer_name) == 1
    assert "2 documents" in html
    assert "₹354.00" in html
    assert "/finance/outstanding/customer/" in html


def test_outstanding_page_sorts_customers_by_name(client, app):
    with app.app_context():
        data = ids()
        zulu_customer = Customer(
            code="SORTZ001",
            name="Sortorder Zulu Customer",
            customer_type="CASH_AND_BILL",
            default_credit_days=30,
            active=True,
        )
        alpha_customer = Customer(
            code="SORTA001",
            name="Sortorder Alpha Customer",
            customer_type="CASH_AND_BILL",
            default_credit_days=30,
            active=True,
        )
        db.session.add_all([zulu_customer, alpha_customer])
        db.session.flush()
        for customer, number in [
            (zulu_customer, "SORTORDER-ZULU-INV"),
            (alpha_customer, "SORTORDER-ALPHA-INV"),
        ]:
            create_sale(
                {
                    "company_id": data["ai"].id,
                    "stock_book_id": data["ai_gst"].id,
                    "customer_id": customer.id,
                    "sale_type": "GST",
                    "invoice_number": number,
                    "invoice_date": "2026-06-23",
                    "due_date": "2026-06-30",
                },
                [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "0"}],
                admin(),
            )
        db.session.commit()

    login(client)
    response = client.get("/finance/outstanding?q=sortorder")
    html = response.get_data(as_text=True)
    customer_table = html.split("<h2>Customer Outstanding</h2>", 1)[1].split(
        "<h2>Supplier Outstanding</h2>", 1
    )[0]

    assert response.status_code == 200
    assert customer_table.index("Sortorder Alpha Customer") < customer_table.index("Sortorder Zulu Customer")


def test_outstanding_page_groups_supplier_once_per_company(client, app):
    with app.app_context():
        data = ids()
        for number, rate in [("PAGE-GROUP-SUP-1", "100"), ("PAGE-GROUP-SUP-2", "200")]:
            create_purchase(
                {
                    "company_id": data["ai"].id,
                    "stock_book_id": data["ai_gst"].id,
                    "supplier_id": data["supplier"].id,
                    "purchase_type": "GST",
                    "bill_number": number,
                    "bill_date": "2026-06-23",
                },
                [{"item_id": data["item"].id, "quantity": "1", "rate": rate, "gst_percent": "18"}],
                admin(),
            )
        supplier_name = data["supplier"].name
        db.session.commit()

    login(client)
    response = client.get("/finance/outstanding")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert html.count(supplier_name) == 1
    assert "2 documents" in html
    assert "₹354.00" in html
    assert "/finance/outstanding/supplier/" in html


def test_outstanding_customer_detail_shows_bill_dates_and_edit_links(client, app):
    with app.app_context():
        data = ids()
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "DETAIL-CUST-INV",
                "invoice_date": "2026-06-23",
                "due_date": "2026-06-30",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        receivable = Receivable.query.filter_by(source_type="SALE", source_id=sale.id).one()
        create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "receivable_id": receivable.id,
                "payment_date": "2026-06-24",
                "amount": "50",
                "mode": "UPI",
                "reference_number": "DETAIL-CUST-RCPT",
            },
            admin(),
        )
        company_id = data["ai"].id
        customer_id = data["customer"].id
        sale_id = sale.id
        db.session.commit()

    login(client)
    response = client.get(f"/finance/outstanding/customer/{company_id}/{customer_id}")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "DETAIL-CUST-INV" in html
    assert "2026-06-23" in html
    assert "2026-06-30" in html
    assert f"/transactions/sale/{sale_id}/edit" in html
    assert "Customer Activity" in html
    assert "Sales Done" in html
    assert "DETAIL-CUST-RCPT" in html


def test_outstanding_hides_paid_and_zero_balance_documents(client, app):
    with app.app_context():
        data = ids()
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "PAID-HIDDEN-INV",
                "invoice_date": "2026-06-23",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "0"}],
            admin(),
        )
        receivable = Receivable.query.filter_by(source_type="SALE", source_id=sale.id).one()
        create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "receivable_id": receivable.id,
                "payment_date": "2026-06-24",
                "amount": "100",
                "mode": "UPI",
                "reference_number": "PAID-HIDDEN-RCPT",
            },
            admin(),
        )
        company_id = data["ai"].id
        customer_id = data["customer"].id
        db.session.commit()

    login(client)
    listing = client.get("/finance/outstanding?q=PAID-HIDDEN-INV")
    listing_html = listing.get_data(as_text=True)
    listing_tables = listing_html.split('id="outstanding_tables"', 1)[1]
    detail = client.get(f"/finance/outstanding/customer/{company_id}/{customer_id}")
    detail_html = detail.get_data(as_text=True)
    bill_section = detail_html.split('id="customer-activity"', 1)[0]

    assert listing.status_code == 200
    assert "PAID-HIDDEN-INV" not in listing_tables
    assert detail.status_code == 200
    assert "PAID-HIDDEN-INV" not in bill_section
    assert "No bill details found" in bill_section


def test_item_ledger_shows_supplier_debtor_and_running_stock(client, app):
    with app.app_context():
        data = ids()
        create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "ITEM-LEDGER-PUR",
                "bill_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "5", "rate": "100", "gst_percent": "0"}],
            admin(),
        )
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "ITEM-LEDGER-SALE",
                "invoice_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "150", "gst_percent": "0"}],
            admin(),
        )
        sale_entry = StockLedgerEntry.query.filter_by(transaction_type="SALE", transaction_id=sale.id).first()
        company_id = data["ai"].id
        item_id = data["item"].id
        highlight_id = sale_entry.id
        supplier_name = data["supplier"].name
        customer_name = data["customer"].name
        StockLedgerEntry.query.filter_by(company_id=company_id, item_id=item_id).delete(synchronize_session=False)
        db.session.commit()

    login(client)
    response = client.get(f"/reports/item-ledger?company_id={company_id}&item_id={item_id}&highlight_id={highlight_id}")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "Item Movement Ledger" in html
    assert "ITEM-LEDGER-PUR" in html
    assert "ITEM-LEDGER-SALE" in html
    assert supplier_name in html
    assert customer_name in html
    assert "current-entry" in html
    assert ">3<" in html
    assert "₹300.00" in html


def test_current_stock_report_links_rows_to_item_history(client, app):
    with app.app_context():
        data = ids()
        company_id = data["ai"].id
        stock_book_id = data["ai_gst"].id
        item_id = data["item"].id
        db.session.commit()

    login(client)
    response = client.get("/reports/current-stock")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "History" in html
    assert 'data-selectable-rows' in html
    assert f"/reports/item-ledger?company_id={company_id}" in html
    assert f"item_id={item_id}" in html
    assert f"stock_book_id={stock_book_id}" in html


def test_customer_receipt_overage_allocates_next_open_bill(app):
    with app.app_context():
        data = ids()
        opening = create_opening_receivable(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "reference_number": "AUTO-ALLOC-OPEN",
                "pending_amount": "36000",
            },
            admin(),
        )
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "AUTO-ALLOC-SALE",
                "invoice_date": "2026-06-06",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "86000", "gst_percent": "0"}],
            admin(),
        )
        sale_receivable = Receivable.query.filter_by(document_number="AUTO-ALLOC-SALE").one()
        payment = create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "receivable_id": opening.id,
                "payment_date": "2026-06-23",
                "amount": "50000",
                "mode": "UPI",
                "reference_number": "AUTO-ALLOC-PAY",
            },
            admin(),
        )
        db.session.commit()

        assert payment.total_amount == 50000
        assert payment.allocated_amount == 50000
        assert payment.unallocated_amount == 0
        assert opening.paid_amount == 36000
        assert opening.balance_amount == 0
        assert sale_receivable.paid_amount == 14000
        assert sale_receivable.balance_amount == 72000


def test_customer_outstanding_nets_unallocated_advance_against_balance(client, app):
    with app.app_context():
        data = ids()
        opening = create_opening_receivable(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "reference_number": "NET-ADV-OPEN",
                "pending_amount": "36000",
            },
            admin(),
        )
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "NET-ADV-SALE",
                "invoice_date": "2026-06-06",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "86000", "gst_percent": "0"}],
            admin(),
        )
        sale_receivable = Receivable.query.filter_by(document_number="NET-ADV-SALE").one()
        create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "receivable_id": opening.id,
                "payment_date": "2026-06-23",
                "amount": "36000",
                "mode": "UPI",
                "reference_number": "NET-ADV-PAY-OPEN",
            },
            admin(),
        )
        create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "receivable_id": sale_receivable.id,
                "payment_date": "2026-06-23",
                "amount": "50000",
                "mode": "UPI",
                "reference_number": "NET-ADV-PAY-SALE",
            },
            admin(),
        )
        advance = create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "payment_date": "2026-06-23",
                "amount": "14000",
                "mode": "UPI",
                "reference_number": "NET-ADV-PAY-ADV",
            },
            admin(),
        )
        db.session.commit()
        company_id = data["ai"].id
        customer_id = data["customer"].id

        assert advance.allocated_amount == 0
        assert advance.unallocated_amount == 14000

    login(client)
    response = client.get(f"/finance/outstanding/customer/{company_id}/{customer_id}")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "₹86,000.00" in html
    assert "₹64,000.00" in html
    assert "₹22,000.00" in html
    assert "Includes ₹14,000.00 advance offset" in html
    assert "Bill balance ₹36,000.00 before advances" in html

    report = client.get("/reports/customer-outstanding")
    report_html = report.get_data(as_text=True)
    assert report.status_code == 200
    assert "₹64,000.00" in report_html
    assert "₹22,000.00" in report_html


def test_outstanding_supplier_detail_shows_bill_dates_and_edit_links(client, app):
    with app.app_context():
        data = ids()
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "DETAIL-SUP-BILL",
                "bill_date": "2026-06-23",
                "due_date": "2026-06-30",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        company_id = data["ai"].id
        supplier_id = data["supplier"].id
        purchase_id = purchase.id
        db.session.commit()

    login(client)
    response = client.get(f"/finance/outstanding/supplier/{company_id}/{supplier_id}")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "DETAIL-SUP-BILL" in html
    assert "2026-06-23" in html
    assert "2026-06-30" in html
    assert f"/transactions/purchase/{purchase_id}/edit" in html


def test_outstanding_detail_respects_fixed_company_scope(client, app):
    with app.app_context():
        data = ids()
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "DETAIL-SCOPE-INV",
                "invoice_date": "2026-06-23",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        company_id = data["ai"].id
        customer_id = data["customer"].id
        db.session.commit()

    login(client, "firsttech.user", "Firsttech2026")
    response = client.get(f"/finance/outstanding/customer/{company_id}/{customer_id}")

    assert response.status_code == 403


def test_customer_outstanding_report_groups_customer_once_per_company(client, app):
    with app.app_context():
        data = ids()
        for number, rate in [("GROUP-CUST-1", "100"), ("GROUP-CUST-2", "200")]:
            create_sale(
                {
                    "company_id": data["ai"].id,
                    "stock_book_id": data["ai_gst"].id,
                    "customer_id": data["customer"].id,
                    "sale_type": "GST",
                    "invoice_number": number,
                    "invoice_date": "2026-06-23",
                },
                [{"item_id": data["item"].id, "quantity": "1", "rate": rate, "gst_percent": "18"}],
                admin(),
            )
        customer_name = data["customer"].name
        db.session.commit()

    login(client)
    response = client.get("/reports/customer-outstanding")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert html.count(customer_name) == 1
    assert "Documents" not in html
    assert "First date" not in html
    assert "Next due" not in html
    assert "Status" not in html
    assert "₹354.00" in html


def test_supplier_outstanding_report_groups_supplier_once_per_company(client, app):
    with app.app_context():
        data = ids()
        for number, rate in [("GROUP-SUP-1", "100"), ("GROUP-SUP-2", "200")]:
            create_purchase(
                {
                    "company_id": data["ai"].id,
                    "stock_book_id": data["ai_gst"].id,
                    "supplier_id": data["supplier"].id,
                    "purchase_type": "GST",
                    "bill_number": number,
                    "bill_date": "2026-06-23",
                },
                [{"item_id": data["item"].id, "quantity": "1", "rate": rate, "gst_percent": "18"}],
                admin(),
            )
        supplier_name = data["supplier"].name
        db.session.commit()

    login(client)
    response = client.get("/reports/supplier-outstanding")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert html.count(supplier_name) == 1
    assert "2 documents" in html
    assert "₹354.00" in html


def test_customer_ledger_summary_and_month_drilldown(client, app):
    with app.app_context():
        data = ids()
        for number, rate in [("LEDGER-INV-1", "100"), ("LEDGER-INV-2", "200")]:
            create_sale(
                {
                    "company_id": data["ai"].id,
                    "stock_book_id": data["ai_gst"].id,
                    "customer_id": data["customer"].id,
                    "sale_type": "GST",
                    "invoice_number": number,
                    "invoice_date": "2026-06-10",
                },
                [{"item_id": data["item"].id, "quantity": "1", "rate": rate, "gst_percent": "18"}],
                admin(),
            )
        receivable = Receivable.query.filter_by(document_number="LEDGER-INV-1").one()
        create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "receivable_id": receivable.id,
                "payment_date": "2026-06-12",
                "amount": "118",
                "mode": "BANK",
                "reference_number": "LEDGER-RCPT-1",
            },
            admin(),
        )
        customer_name = data["customer"].name
        company_id = data["ai"].id
        customer_id = data["customer"].id
        db.session.commit()

    login(client)
    response = client.get("/reports/customer-ledger")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert b"Customer Ledger" in response.data
    assert customer_name in html
    assert "June 2026" in html
    assert "2" in html
    assert "₹354.00" in html
    assert "₹118.00" in html
    assert f"/reports/customer-ledger/detail?company_id={company_id}&amp;customer_id={customer_id}&amp;month=2026-06" in html

    detail = client.get(f"/reports/customer-ledger/detail?company_id={company_id}&customer_id={customer_id}&month=2026-06")
    detail_html = detail.get_data(as_text=True)

    assert detail.status_code == 200
    assert "LEDGER-INV-1" in detail_html
    assert "LEDGER-INV-2" in detail_html
    assert "LEDGER-RCPT-1" in detail_html
    assert "Opening Balance" in detail_html
    assert "Closing Balance" in detail_html
    assert "₹236.00" in detail_html


def test_customer_ledger_respects_fixed_company_scope(client, app):
    with app.app_context():
        data = ids()
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "AI-LEDGER-HIDDEN",
                "invoice_date": "2026-06-10",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        create_sale(
            {
                "company_id": data["fml"].id,
                "stock_book_id": data["fml_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "FML-LEDGER-SHOWN",
                "invoice_date": "2026-06-10",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "200", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()

    login(client, "firsttech.user", "Firsttech2026")
    response = client.get("/reports/customer-ledger")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "FML" in html
    assert "AI - Aditya International" not in html
    assert "₹236.00" in html
    assert "₹118.00" not in html
