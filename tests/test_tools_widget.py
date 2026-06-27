from app.extensions import db
from app.services.transactions import create_purchase, create_sale
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login


def test_floating_tools_render_on_authenticated_pages(client):
    login(client)

    response = client.get("/dashboard/")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'data-tool-toggle="calculator"' in html
    assert 'data-tool-toggle="calendar"' in html
    assert 'data-calendar-url="/dashboard/calendar-events"' in html


def test_calendar_events_endpoint_returns_transaction_and_due_dates(client, app):
    with app.app_context():
        data = ids()
        user = admin()
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "TOOLS-INV",
                "invoice_date": "2026-06-05",
                "due_date": "2026-06-12",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "0"}],
            user,
        )
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "TOOLS-BILL",
                "bill_date": "2026-06-07",
                "due_date": "2026-06-14",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "80", "gst_percent": "0"}],
            user,
        )
        db.session.commit()
        sale_id = sale.id
        purchase_id = purchase.id

    login(client)
    response = client.get("/dashboard/calendar-events?start=2026-06-01&end=2026-06-30")
    payload = response.get_json()
    titles = [event["title"] for event in payload["events"]]
    kinds = [event["kind"] for event in payload["events"]]
    urls = [event["url"] for event in payload["events"]]

    assert response.status_code == 200
    assert any("TOOLS-INV" in title for title in titles)
    assert any("TOOLS-BILL" in title for title in titles)
    assert "Receivable due" in kinds
    assert "Payable due" in kinds
    assert f"/transactions/sale/{sale_id}/edit" in urls
    assert f"/transactions/purchase/{purchase_id}/edit" in urls
