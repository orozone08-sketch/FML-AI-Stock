from app.extensions import db
from app.services.payments import create_customer_receipt
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login


def test_customer_advance_is_visible_in_outstanding(client, app):
    with app.app_context():
        data = ids()
        create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "payment_date": "2026-11-10",
                "amount": "12500",
                "mode": "CASH",
                "reference_number": "ADVANCE-OUTSTANDING-1",
            },
            admin(),
        )
        db.session.commit()
        customer_name = data["customer"].name

    login(client)
    response = client.get("/finance/outstanding")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert customer_name in html
    assert "Advance only" in html
    assert "ADVANCE" in html
    assert "₹12,500.00" in html

    report = client.get("/reports/customer-outstanding")
    report_html = report.get_data(as_text=True)
    assert report.status_code == 200
    assert customer_name in report_html
    assert "₹12,500.00" in report_html
