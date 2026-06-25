from app.extensions import db
from app.models import Customer, Receivable
from app.services.payments import create_customer_receipt
from app.services.transactions import create_purchase, create_sale
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login


def seed_customer_profile_data():
    data = ids()
    customer = data["customer"]
    customer.contact_person = "Amarjit Contact"
    customer.mobile = "9999999999"
    customer.whatsapp = "8888888888"
    customer.gst_number = "GSTPROFILE1"
    customer.city = "Mumbai"
    customer.state = "Maharashtra"
    customer.email = "profile@example.com"
    customer.address = "Profile address"
    customer.notes = "Important profile note"
    sale = create_sale(
        {
            "company_id": data["ai"].id,
            "stock_book_id": data["ai_gst"].id,
            "customer_id": customer.id,
            "sale_type": "GST",
            "invoice_number": "PROFILE-INV-1",
            "invoice_date": "2026-06-25",
            "due_date": "2026-06-30",
        },
        [{"item_id": data["item"].id, "quantity": "2", "rate": "100", "gst_percent": "18"}],
        admin(),
    )
    receivable = Receivable.query.filter_by(document_number="PROFILE-INV-1").one()
    create_customer_receipt(
        {
            "company_id": data["ai"].id,
            "customer_id": customer.id,
            "receivable_id": receivable.id,
            "payment_date": "2026-06-25",
            "amount": "118",
            "mode": "BANK",
            "reference_number": "PROFILE-RCPT-1",
        },
        admin(),
    )
    db.session.commit()
    return customer.id, sale.id


def test_customer_list_search_clickable_names_and_profile_page(client, app):
    with app.app_context():
        customer_id, sale_id = seed_customer_profile_data()

    login(client)
    response = client.get("/masters/customers?q=Mumbai")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert f"/masters/customers/{customer_id}" in html
    assert "View Details" in html
    assert "GSTPROFILE1" in html
    assert "data-customer-jump" in html

    detail = client.get(f"/masters/customers/{customer_id}")
    detail_html = detail.get_data(as_text=True)

    assert detail.status_code == 200
    assert "Overview" in detail_html
    assert "Invoices" in detail_html
    assert "Challans" in detail_html
    assert "Stock" in detail_html
    assert "Payments" in detail_html
    assert "Notes / Documents" in detail_html
    assert "PROFILE-INV-1" in detail_html
    assert "PROFILE-RCPT-1" in detail_html
    assert "Important profile note" in detail_html
    assert f"/transactions/sale/{sale_id}/edit" in detail_html
    assert f"/transactions/sale/{sale_id}/export/pdf" in detail_html


def test_customer_list_includes_purchase_linked_suppliers(client, app):
    with app.app_context():
        data = ids()
        create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "PROFILE-SUP-PUR",
                "bill_date": "2026-06-25",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        supplier_name = data["supplier"].name
        supplier_id = data["supplier"].id
        db.session.commit()

    login(client)
    response = client.get(f"/masters/customers?q={supplier_name}")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert supplier_name in html
    assert "Supplier from purchase" in html
    assert f"/masters/suppliers/{supplier_id}/edit" in html


def test_customer_json_apis_use_customer_id(client, app):
    with app.app_context():
        customer_id, _sale_id = seed_customer_profile_data()

    login(client)

    listing = client.get("/customers?q=GSTPROFILE1")
    assert listing.status_code == 200
    listing_json = listing.get_json()
    assert listing_json["customers"][0]["id"] == customer_id
    assert listing_json["customers"][0]["customer_name"]

    detail = client.get(f"/customers/{customer_id}")
    assert detail.status_code == 200
    detail_json = detail.get_json()
    assert detail_json["summary"]["total_invoices"] == 1
    assert detail_json["invoices"][0]["invoice_number"] == "PROFILE-INV-1"
    assert detail_json["challans"][0]["challan_number"] == "PROFILE-INV-1"
    assert detail_json["stock"]["rows"][0]["challan_number"] == "PROFILE-INV-1"
    assert detail_json["payments"][0]["reference_number"] == "PROFILE-RCPT-1"
    assert detail_json["documents"][0]["type"] == "Invoice PDF"

    invoices = client.get(f"/customers/{customer_id}/invoices")
    assert invoices.status_code == 200
    assert invoices.get_json()["invoices"][0]["invoice_number"] == "PROFILE-INV-1"

    challans = client.get(f"/customers/{customer_id}/challans")
    assert challans.status_code == 200
    assert challans.get_json()["challans"][0]["challan_number"] == "PROFILE-INV-1"

    payments = client.get(f"/customers/{customer_id}/payments")
    assert payments.status_code == 200
    assert payments.get_json()["payments"][0]["reference_number"] == "PROFILE-RCPT-1"

    stock = client.get(f"/customers/{customer_id}/stock")
    assert stock.status_code == 200
    assert stock.get_json()["stock"][0]["challan_number"] == "PROFILE-INV-1"


def test_customer_profile_respects_fixed_company_scope(client, app):
    with app.app_context():
        data = ids()
        customer = Customer.query.first()
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": customer.id,
                "sale_type": "GST",
                "invoice_number": "AI-PROFILE-HIDDEN",
                "invoice_date": "2026-06-25",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        create_sale(
            {
                "company_id": data["fml"].id,
                "stock_book_id": data["fml_gst"].id,
                "customer_id": customer.id,
                "sale_type": "GST",
                "invoice_number": "FML-PROFILE-SHOWN",
                "invoice_date": "2026-06-25",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "200", "gst_percent": "18"}],
            admin(),
        )
        customer_id = customer.id
        db.session.commit()

    login(client, "firsttech.user", "Firsttech2026")
    response = client.get(f"/masters/customers/{customer_id}")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "FML-PROFILE-SHOWN" in html
    assert "AI-PROFILE-HIDDEN" not in html
