import re

from app.extensions import db
from app.models import Customer
from app.services.transactions import create_purchase, create_sale
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login


def test_duplicate_customer_code_shows_friendly_error(client, app):
    with app.app_context():
        customer_code = ids()["customer"].code

    login(client)
    response = client.post(
        "/masters/customers/new",
        data={
            "code": customer_code,
            "name": "Duplicate Customer",
            "customer_type": "CASH_AND_BILL",
            "default_credit_days": "30",
            "active": "on",
        },
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert b"already exists" in response.data
    assert b"IntegrityError" not in response.data
    assert b"Duplicate entry" not in response.data


def test_duplicate_customer_name_is_blocked_case_insensitively(client, app):
    with app.app_context():
        existing_name = ids()["customer"].name

    login(client)
    response = client.post(
        "/masters/customers/new",
        data={
            "code": "UNIQUECASE01",
            "name": existing_name.upper(),
            "customer_type": "CASH_AND_BILL",
            "default_credit_days": "30",
            "active": "on",
        },
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert b"already exists" in response.data
    assert b"Open the existing customer" in response.data


def test_customer_edit_rejects_stale_second_user_update(app):
    first_client = app.test_client()
    second_client = app.test_client()
    login(first_client)
    login(second_client)
    with app.app_context():
        customer = ids()["customer"]
        customer_id = customer.id
        customer_code = customer.code
        customer_type = customer.customer_type
        credit_days = customer.default_credit_days

    first_page = first_client.get(f"/masters/customers/{customer_id}/edit")
    second_page = second_client.get(f"/masters/customers/{customer_id}/edit")
    first_html = first_page.get_data(as_text=True)
    second_html = second_page.get_data(as_text=True)
    first_token = re.search(r'name="csrf_token" value="([^"]+)"', first_html).group(1)
    second_token = re.search(r'name="csrf_token" value="([^"]+)"', second_html).group(1)
    first_version = re.search(r'name="edit_version" value="([^"]+)"', first_html).group(1)
    second_version = re.search(r'name="edit_version" value="([^"]+)"', second_html).group(1)

    common = {
        "code": customer_code,
        "customer_type": customer_type,
        "default_credit_days": str(credit_days),
        "active": "on",
    }
    first_data = {**common, "csrf_token": first_token, "edit_version": first_version, "name": "First User Update"}
    second_data = {**common, "csrf_token": second_token, "edit_version": second_version, "name": "Second User Update"}

    first_response = first_client.post(
        f"/masters/customers/{customer_id}/edit", data=first_data, follow_redirects=True
    )
    second_response = second_client.post(
        f"/masters/customers/{customer_id}/edit", data=second_data, follow_redirects=True
    )

    assert first_response.status_code == 200
    assert b"updated" in first_response.data
    assert second_response.status_code == 200
    assert b"updated by another user" in second_response.data
    with app.app_context():
        customer = db.session.get(Customer, customer_id)
        assert customer.name == "First User Update"


def test_customer_name_key_is_database_unique(app):
    with app.app_context():
        existing = ids()["customer"]
        duplicate = Customer(
            code="DUP-NAME-DB",
            name=existing.name.upper(),
            customer_type="CASH_AND_BILL",
            default_credit_days=30,
            active=True,
        )
        db.session.add(duplicate)
        try:
            db.session.commit()
        except Exception:
            db.session.rollback()
        else:
            raise AssertionError("Duplicate normalized customer name was accepted")


def test_master_lists_include_live_search_and_find_button(client):
    login(client)

    response = client.get("/masters/items")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert "data-live-search" in html
    assert "data-live-target" in html
    assert "<datalist" in html
    assert ">Find</button>" in html


def test_supplier_master_has_transactions_drilldown(client, app):
    with app.app_context():
        data = ids()
        create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "SUP-MASTER-TXN",
                "bill_date": "2026-06-25",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        supplier_id = data["supplier"].id
        db.session.commit()

    login(client)
    response = client.get("/masters/suppliers")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert f"/masters/suppliers/{supplier_id}/transactions" in html
    assert "Transactions" in html


def test_unused_customer_can_be_deleted_from_directory(client, app):
    with app.app_context():
        customer = Customer(
            code="DEL001",
            name="Delete Me Customer",
            customer_type="CASH_AND_BILL",
            default_credit_days=30,
            active=True,
        )
        db.session.add(customer)
        db.session.commit()
        customer_id = customer.id

    login(client)
    response = client.post(f"/masters/customers/{customer_id}/delete", follow_redirects=True)

    assert response.status_code == 200
    assert b"Customer deleted" in response.data
    with app.app_context():
        assert db.session.get(Customer, customer_id) is None


def test_customer_with_transactions_is_deactivated_instead_of_deleted(client, app):
    with app.app_context():
        data = ids()
        customer = Customer(
            code="DELTXN001",
            name="Delete Transaction Customer",
            customer_type="CASH_AND_BILL",
            default_credit_days=30,
            active=True,
        )
        db.session.add(customer)
        db.session.flush()
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": customer.id,
                "sale_type": "GST",
                "invoice_number": "DELTXN-INV-1",
                "invoice_date": "2026-06-25",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()
        customer_id = customer.id

    login(client)
    response = client.post(f"/masters/customers/{customer_id}/delete", follow_redirects=True)

    assert response.status_code == 200
    assert b"deactivated instead of permanently deleted" in response.data
    with app.app_context():
        customer = db.session.get(Customer, customer_id)
        assert customer is not None
        assert customer.active is False


def test_customer_form_has_cash_bill_and_combined_type_options(client):
    login(client)

    response = client.get("/masters/customers/new")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    assert 'value="CASH"' in html
    assert 'value="BILL"' in html
    assert 'value="CASH_AND_BILL"' in html
