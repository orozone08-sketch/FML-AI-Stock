from app.extensions import db
from app.models import Receivable
from app.services.payments import create_customer_receipt
from app.services.transactions import create_purchase, create_sale
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
    response = client.get(f"/finance/outstanding?q={customer_name}")

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
    assert "2 documents" in html
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
