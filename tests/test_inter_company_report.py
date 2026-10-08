from app.extensions import db
from app.services.transactions import create_opening_stock, create_purchase, create_sale, create_transfer
from tests.test_fifo_workflows import admin, ids


def test_inter_company_report_includes_all_sources_and_detail_pages(client, app):
    with app.app_context():
        data = ids()
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "counterparty_company_id": data["fml"].id,
                "sale_type": "GST",
                "invoice_number": "INTER-SALE-DETAIL",
                "invoice_date": "2026-06-10",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        purchase = create_purchase(
            {
                "company_id": data["fml"].id,
                "stock_book_id": data["fml_gst"].id,
                "supplier_id": data["supplier"].id,
                "counterparty_company_id": data["ai"].id,
                "purchase_type": "GST",
                "bill_number": "INTER-PURCHASE-DETAIL",
                "bill_date": "2026-06-11",
            },
            [{"item_id": data["item"].id, "quantity": "3", "rate": "90", "gst_percent": "18"}],
            admin(),
        )
        create_opening_stock(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "reference_number": "INTER-TRANSFER-OPEN",
                "opening_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "5", "rate": "50"}],
            admin(),
        )
        transfer = create_transfer(
            {
                "from_company_id": data["ai"].id,
                "from_stock_book_id": data["ai_gst"].id,
                "to_company_id": data["fml"].id,
                "to_stock_book_id": data["fml_gst"].id,
                "reference_number": "INTER-TRANSFER-DETAIL",
                "transfer_date": "2026-06-12",
            },
            [{"item_id": data["item"].id, "quantity": "1"}],
            admin(),
        )
        db.session.commit()

        sale_id = sale.id
        purchase_id = purchase.id
        transfer_id = transfer.id
        item_display_name = data["item"].display_name

    response = client.post(
        "/admin/login",
        data={"email": "admin@fastockflow.local", "password": "Abhijeet2026"},
        follow_redirects=True,
    )
    assert response.status_code == 200

    report = client.get("/reports/inter-company")
    html = report.get_data(as_text=True)
    assert report.status_code == 200
    assert "INTER-SALE-DETAIL" in html
    assert "INTER-PURCHASE-DETAIL" in html
    assert "INTER-TRANSFER-DETAIL" in html
    assert "View Details" in html
    assert f"/reports/inter-company/SALE/{sale_id}" in html
    assert f"/reports/inter-company/PURCHASE/{purchase_id}" in html
    assert f"/reports/inter-company/TRANSFER/{transfer_id}" in html

    detail = client.get(f"/reports/inter-company/SALE/{sale_id}")
    detail_html = detail.get_data(as_text=True)
    assert detail.status_code == 200
    assert "Complete source document" in detail_html
    assert "Subtotal" in detail_html
    assert "GST" in detail_html
    assert item_display_name in detail_html
    assert "₹236.00" in detail_html