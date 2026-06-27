from app.extensions import db
from app.services.transactions import (
    create_opening_advance_received,
    create_opening_payable,
    create_opening_receivable,
    create_opening_stock,
    create_purchase,
    create_sale,
    create_transfer,
)
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login


def test_transaction_rows_include_pdf_xl_links_and_exports_download(client, app):
    with app.app_context():
        data = ids()
        user = admin()
        opening = create_opening_stock(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "reference_number": "EXPORT-OPENING",
                "opening_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "8", "rate": "100"}],
            user,
        )
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "EXPORT-BILL",
                "bill_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "125", "gst_percent": "18"}],
            user,
        )
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "EXPORT-INV",
                "invoice_date": "2026-06-03",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "150", "gst_percent": "18"}],
            user,
        )
        transfer = create_transfer(
            {
                "from_company_id": data["ai"].id,
                "from_stock_book_id": data["ai_gst"].id,
                "to_company_id": data["fml"].id,
                "to_stock_book_id": data["fml_gst"].id,
                "reference_number": "EXPORT-TRF",
                "transfer_date": "2026-06-04",
            },
            [{"item_id": data["item"].id, "quantity": "1"}],
            user,
        )
        receivable = create_opening_receivable(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "reference_number": "EXPORT-REC",
                "pending_amount": "500",
            },
            user,
        )
        payable = create_opening_payable(
            {
                "company_id": data["ai"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "reference_number": "EXPORT-PAY",
                "pending_amount": "400",
            },
            user,
        )
        advance = create_opening_advance_received(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "amount": "300",
                "mode": "CASH",
                "reference_number": "EXPORT-ADV",
            },
            user,
        )
        db.session.commit()
        record_ids = {
            "opening": opening.id,
            "purchase": purchase.id,
            "sale": sale.id,
            "transfer": transfer.id,
            "receivable": receivable.id,
            "payable": payable.id,
            "advance": advance.id,
            "customer": data["customer"].id,
            "supplier": data["supplier"].id,
            "company": data["ai"].id,
        }

    login(client)
    purchase_page = client.get("/transactions/purchase").get_data(as_text=True)
    sale_page = client.get("/transactions/sale").get_data(as_text=True)
    transfer_page = client.get("/transactions/transfer").get_data(as_text=True)
    opening_page = client.get("/transactions/opening").get_data(as_text=True)
    payments_page = client.get("/finance/payments").get_data(as_text=True)

    assert f"/transactions/purchase/{record_ids['purchase']}/export/pdf" in purchase_page
    assert f"/transactions/purchase/{record_ids['purchase']}/export/xlsx" in purchase_page
    assert f"/transactions/purchase/{record_ids['purchase']}/print" in purchase_page
    assert f"/transactions/sale/{record_ids['sale']}/export/pdf" in sale_page
    assert f"/transactions/sale/{record_ids['sale']}/print" in sale_page
    assert f"/transactions/transfer/{record_ids['transfer']}/export/xlsx" in transfer_page
    assert f"/transactions/transfer/{record_ids['transfer']}/print" in transfer_page
    assert f"/transactions/opening/stock/{record_ids['opening']}/export/pdf" in opening_page
    assert f"/transactions/opening/stock/{record_ids['opening']}/print" in opening_page
    assert f"/transactions/opening/receivable/{record_ids['receivable']}/export/xlsx" in opening_page
    assert f"/transactions/opening/payable/{record_ids['payable']}/export/pdf" in opening_page
    assert f"/transactions/opening/advance/{record_ids['advance']}/export/xlsx" in opening_page
    assert "/reports/stock-ledger?q=EXPORT-OPENING" in opening_page
    assert f"/masters/customers/{record_ids['customer']}?company_id={record_ids['company']}" in opening_page
    assert f"/masters/suppliers/{record_ids['supplier']}/transactions?company_id={record_ids['company']}" in opening_page
    assert f"/finance/payments/{record_ids['advance']}/export/pdf" in payments_page
    assert f"/finance/payments/{record_ids['advance']}/print" in payments_page

    downloads = [
        (f"/transactions/purchase/{record_ids['purchase']}/export/pdf", "application/pdf"),
        (
            f"/transactions/sale/{record_ids['sale']}/export/xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        (f"/transactions/transfer/{record_ids['transfer']}/export/pdf", "application/pdf"),
        (f"/transactions/opening/stock/{record_ids['opening']}/export/xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        (f"/finance/payments/{record_ids['advance']}/export/pdf", "application/pdf"),
    ]
    for url, mimetype in downloads:
        response = client.get(url)
        assert response.status_code == 200
        assert response.mimetype == mimetype
        response.get_data()
        response.close()

    print_response = client.get(f"/transactions/sale/{record_ids['sale']}/print")
    assert print_response.status_code == 200
    assert print_response.mimetype == "text/html"
    assert "EXPORT-INV" in print_response.get_data(as_text=True)
