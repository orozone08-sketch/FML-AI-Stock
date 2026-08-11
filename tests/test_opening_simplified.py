from datetime import date

from app.extensions import db
from app.models import (
    FIFOLayer,
    InterCompanyLedgerEntry,
    InterCompanyTransfer,
    OpeningStock,
    Payable,
    Payment,
    Receivable,
    StockLedgerEntry,
)
from app.services.payments import create_customer_receipt, create_supplier_payment
from app.services.transactions import create_opening_payable, create_opening_receivable
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login


def test_opening_page_hides_stock_book_and_rate_fields(client):
    login(client)
    response = client.get("/transactions/opening")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "Stock book <select" not in html
    assert "Owner stock book" not in html
    assert "User stock book" not in html
    assert '<span>Rate</span>' not in html
    assert 'name="rate[]"' not in html


def test_opening_stock_saves_without_stock_book_or_rate(client, app):
    with app.app_context():
        data = ids()
        company_id = data["ai"].id
        item_id = data["item"].id

    login(client)
    response = client.post(
        "/transactions/opening/stock",
        data={
            "company_id": company_id,
            "reference_number": "OPEN-NO-RATE",
            "opening_date": "2026-06-22",
            "item_id[]": [item_id],
            "quantity[]": ["5"],
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening stock OPEN-NO-RATE saved." in response.data

    with app.app_context():
        opening = OpeningStock.query.filter_by(reference_number="OPEN-NO-RATE").one()
        layer = FIFOLayer.query.filter_by(
            source_type="OPENING_STOCK",
            source_id=opening.id,
        ).one()
        assert opening.stock_book.code == "AI_GST"
        assert layer.unit_cost == 0
        assert layer.available_quantity == 5


def test_opening_stock_can_be_negative(client, app):
    with app.app_context():
        data = ids()
        company_id = data["ai"].id
        item_id = data["item"].id

    login(client)
    response = client.post(
        "/transactions/opening/stock",
        data={
            "company_id": company_id,
            "reference_number": "OPEN-NEGATIVE",
            "opening_date": "2026-06-22",
            "item_id[]": [item_id],
            "quantity[]": ["-2"],
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening stock OPEN-NEGATIVE saved." in response.data

    with app.app_context():
        opening = OpeningStock.query.filter_by(reference_number="OPEN-NEGATIVE").one()
        ledger = StockLedgerEntry.query.filter_by(
            transaction_type="OPENING_STOCK",
            transaction_id=opening.id,
        ).one()
        assert opening.lines[0].quantity == -2
        assert ledger.quantity_in == 0
        assert ledger.quantity_out == 2
        assert FIFOLayer.query.filter_by(source_type="OPENING_STOCK", source_id=opening.id).count() == 0


def test_opening_pending_stock_saves_without_stock_books_or_rate(client, app):
    with app.app_context():
        data = ids()
        owner_id = data["fml"].id
        user_id = data["ai"].id
        item_id = data["item"].id

    login(client)
    response = client.post(
        "/transactions/opening/pending-stock",
        data={
            "from_company_id": owner_id,
            "to_company_id": user_id,
            "reference_number": "PEND-NO-RATE",
            "transfer_date": "2026-06-22",
            "item_id[]": [item_id],
            "quantity[]": ["3"],
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening pending stock PEND-NO-RATE saved." in response.data

    with app.app_context():
        transfer = InterCompanyTransfer.query.filter_by(reference_number="PEND-NO-RATE").one()
        assert transfer.from_stock_book.code == "FML_GST"
        assert transfer.to_stock_book.code == "AI_GST"
        assert transfer.lines[0].fifo_value == 0


def test_opening_pending_stock_can_be_negative(client, app):
    with app.app_context():
        data = ids()
        owner_id = data["fml"].id
        user_id = data["ai"].id
        item_id = data["item"].id

    login(client)
    response = client.post(
        "/transactions/opening/pending-stock",
        data={
            "from_company_id": owner_id,
            "to_company_id": user_id,
            "reference_number": "PEND-NEGATIVE",
            "transfer_date": "2026-06-22",
            "item_id[]": [item_id],
            "quantity[]": ["-3"],
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening pending stock PEND-NEGATIVE saved." in response.data

    with app.app_context():
        transfer = InterCompanyTransfer.query.filter_by(reference_number="PEND-NEGATIVE").one()
        ledger = InterCompanyLedgerEntry.query.filter_by(transfer_id=transfer.id).one()
        assert transfer.lines[0].quantity == -3
        assert transfer.lines[0].fifo_value == 0
        assert ledger.quantity == -3


def test_opening_summary_can_delete_receivable_payable_and_advance(client, app):
    with app.app_context():
        data = ids()
        company_id = data["ai"].id
        customer_id = data["customer"].id
        supplier_id = data["supplier"].id

    login(client)
    client.post(
        "/transactions/opening/receivable",
        data={
            "company_id": company_id,
            "customer_id": customer_id,
            "sale_type": "GST",
            "reference_number": "OPEN-REC-DELETE",
            "invoice_date": "2026-06-22",
            "due_date": "2026-06-30",
            "pending_amount": "78440",
        },
        follow_redirects=True,
    )
    client.post(
        "/transactions/opening/payable",
        data={
            "company_id": company_id,
            "supplier_id": supplier_id,
            "purchase_type": "GST",
            "reference_number": "OPEN-PAY-DELETE",
            "bill_date": "2026-06-22",
            "due_date": "2026-06-30",
            "pending_amount": "12500",
        },
        follow_redirects=True,
    )
    client.post(
        "/transactions/opening/advance-received",
        data={
            "company_id": company_id,
            "customer_id": customer_id,
            "payment_date": "2026-06-22",
            "mode": "CASH",
            "reference_number": "OPEN-ADV-DELETE",
            "amount": "5000",
        },
        follow_redirects=True,
    )

    response = client.get("/transactions/opening")
    html = response.get_data(as_text=True)
    assert "/transactions/opening/receivable/" in html
    assert "/transactions/opening/payable/" in html
    assert "/transactions/opening/advance/" in html
    assert "/transactions/opening/receivable/" in html and "/edit" in html
    assert "/transactions/opening/payable/" in html and "/edit" in html
    assert "/transactions/opening/advance/" in html and "/edit" in html

    with app.app_context():
        receivable = Receivable.query.filter_by(document_number="OPEN-REC-DELETE").one()
        payable = Payable.query.filter_by(document_number="OPEN-PAY-DELETE").one()
        payment = Payment.query.filter_by(reference_number="OPEN-ADV-DELETE").one()
        receivable_id = receivable.id
        payable_id = payable.id
        payment_id = payment.id

    response = client.post(
        f"/transactions/opening/receivable/{receivable_id}/delete",
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening receivable deleted." in response.data

    response = client.post(
        f"/transactions/opening/payable/{payable_id}/delete",
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening payable deleted." in response.data

    response = client.post(
        f"/transactions/opening/advance/{payment_id}/delete",
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening advance deleted." in response.data

    with app.app_context():
        assert Receivable.query.filter_by(document_number="OPEN-REC-DELETE").count() == 0
        assert Payable.query.filter_by(document_number="OPEN-PAY-DELETE").count() == 0
        assert Payment.query.filter_by(reference_number="OPEN-ADV-DELETE").count() == 0


def test_opening_receivable_dates_are_optional_and_entry_can_be_edited(client, app):
    with app.app_context():
        data = ids()
        company_id = data["ai"].id
        customer_id = data["customer"].id

    login(client)
    response = client.post(
        "/transactions/opening/receivable",
        data={
            "company_id": company_id,
            "customer_id": customer_id,
            "sale_type": "GST",
            "reference_number": "",
            "invoice_date": "",
            "due_date": "",
            "pending_amount": "1500",
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening receivable OPN-REC-" in response.data

    with app.app_context():
        receivable = Receivable.query.filter(Receivable.document_number.like("OPN-REC-%")).one()
        receivable_id = receivable.id
        assert receivable.document_date == date.today()
        assert receivable.due_date is None

    response = client.post(
        f"/transactions/opening/receivable/{receivable_id}/edit",
        data={
            "company_id": company_id,
            "customer_id": customer_id,
            "sale_type": "GST",
            "reference_number": "OPEN-REC-EDITED",
            "invoice_date": "",
            "due_date": "",
            "pending_amount": "2500",
        },
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert b"Opening receivable updated." in response.data

    with app.app_context():
        receivable = Receivable.query.filter_by(document_number="OPEN-REC-EDITED").one()
        assert receivable.total_amount == 2500
        assert receivable.balance_amount == 2500


def test_allocated_opening_receivable_can_be_safely_edited(client, app):
    with app.app_context():
        data = ids()
        receivable = create_opening_receivable(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "sale_type": "CASH",
                "reference_number": "OPEN-REC-ALLOC",
                "invoice_date": "2026-05-31",
                "due_date": "2026-05-31",
                "pending_amount": "86000",
            },
            admin(),
        )
        create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "receivable_id": receivable.id,
                "payment_date": "2026-06-25",
                "amount": "50000",
                "mode": "UPI",
                "reference_number": "OPEN-REC-ALLOC-PAY",
            },
            admin(),
        )
        db.session.commit()
        receivable_id = receivable.id
        company_id = data["ai"].id
        customer_id = data["customer"].id

    login(client)
    response = client.post(
        f"/transactions/opening/receivable/{receivable_id}/edit",
        data={
            "company_id": company_id,
            "customer_id": customer_id,
            "sale_type": "CASH",
            "reference_number": "OPEN-REC-ALLOC-EDITED",
            "invoice_date": "2026-05-31",
            "due_date": "2026-06-30",
            "pending_amount": "90000",
            "remarks": "Corrected after receipt",
        },
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert b"Opening receivable updated." in response.data
    with app.app_context():
        receivable = db.session.get(Receivable, receivable_id)
        assert receivable.document_number == "OPEN-REC-ALLOC-EDITED"
        assert receivable.total_amount == 90000
        assert receivable.paid_amount == 50000
        assert receivable.balance_amount == 40000
        assert receivable.payment_status == "PARTIAL"

    response = client.post(
        f"/transactions/opening/receivable/{receivable_id}/edit",
        data={
            "company_id": company_id,
            "customer_id": customer_id,
            "sale_type": "CASH",
            "reference_number": "OPEN-REC-ALLOC-LOW",
            "invoice_date": "2026-05-31",
            "due_date": "2026-06-30",
            "pending_amount": "49999",
        },
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert b"Opening receivable amount cannot be less than already received amount." in response.data
    with app.app_context():
        receivable = db.session.get(Receivable, receivable_id)
        assert receivable.document_number == "OPEN-REC-ALLOC-EDITED"
        assert receivable.total_amount == 90000


def test_receipt_remainder_does_not_auto_allocate_opening_receivable(client, app):
    with app.app_context():
        data = ids()
        regular = Receivable(
            company_id=data["ai"].id,
            customer_id=data["customer"].id,
            source_type="SALE",
            source_id=999999,
            document_number="REGULAR-REC-REMAINDER",
            document_date=date(2026, 6, 20),
            total_amount=100,
            balance_amount=100,
            payment_status="UNPAID",
            is_opening=False,
        )
        db.session.add(regular)
        db.session.flush()
        opening = create_opening_receivable(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "sale_type": "CASH",
                "reference_number": "OPEN-REC-REMAINDER",
                "invoice_date": "2026-06-21",
                "pending_amount": "20000",
            },
            admin(),
        )
        payment = create_customer_receipt(
            {
                "company_id": data["ai"].id,
                "customer_id": data["customer"].id,
                "receivable_id": regular.id,
                "payment_date": "2026-06-25",
                "amount": "500",
                "mode": "CASH",
                "reference_number": "OPEN-REC-REMAINDER-PAY",
            },
            admin(),
        )
        db.session.commit()

        assert regular.paid_amount == 100
        assert regular.balance_amount == 0
        assert opening.paid_amount == 0
        assert opening.balance_amount == 20000
        assert payment.allocated_amount == 100
        assert payment.unallocated_amount == 400


def test_allocated_opening_payable_can_be_safely_edited(client, app):
    with app.app_context():
        data = ids()
        payable = create_opening_payable(
            {
                "company_id": data["ai"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "reference_number": "OPEN-PAY-ALLOC",
                "bill_date": "2026-05-31",
                "due_date": "2026-06-30",
                "pending_amount": "25000",
            },
            admin(),
        )
        create_supplier_payment(
            {
                "company_id": data["ai"].id,
                "supplier_id": data["supplier"].id,
                "payable_id": payable.id,
                "payment_date": "2026-06-25",
                "amount": "10000",
                "mode": "BANK",
                "reference_number": "OPEN-PAY-ALLOC-PAY",
            },
            admin(),
        )
        db.session.commit()
        payable_id = payable.id
        company_id = data["ai"].id
        supplier_id = data["supplier"].id

    login(client)
    response = client.post(
        f"/transactions/opening/payable/{payable_id}/edit",
        data={
            "company_id": company_id,
            "supplier_id": supplier_id,
            "purchase_type": "GST",
            "reference_number": "OPEN-PAY-ALLOC-EDITED",
            "bill_date": "2026-05-31",
            "due_date": "2026-06-30",
            "pending_amount": "30000",
        },
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert b"Opening payable updated." in response.data
    with app.app_context():
        payable = db.session.get(Payable, payable_id)
        assert payable.document_number == "OPEN-PAY-ALLOC-EDITED"
        assert payable.total_amount == 30000
        assert payable.paid_amount == 10000
        assert payable.balance_amount == 20000
        assert payable.payment_status == "PARTIAL"
