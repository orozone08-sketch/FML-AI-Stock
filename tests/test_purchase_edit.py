from app.extensions import db
import pytest
from decimal import Decimal

from app.models import FIFOLayer, Payable, Purchase, StockLedgerEntry
from app.services.stock import available_quantity
from app.services.transactions import create_purchase, create_sale, update_purchase_header, update_purchase_lines
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login


def test_purchase_header_edit_updates_linked_references(app):
    with app.app_context():
        data = ids()
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "OLD-BILL",
                "bill_date": "2026-06-01",
                "due_date": "2026-06-15",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()

        update_purchase_header(
            purchase,
            {
                "supplier_id": data["supplier"].id,
                "bill_number": "NEW-BILL",
                "bill_date": "2026-06-02",
                "due_date": "2026-06-20",
                "remarks": "Corrected bill details",
            },
            admin(),
        )
        db.session.commit()

        purchase = Purchase.query.filter_by(bill_number="NEW-BILL").one()
        payable = Payable.query.filter_by(source_type="PURCHASE", source_id=purchase.id).one()
        layer = FIFOLayer.query.filter_by(source_type="PURCHASE", source_id=purchase.id).one()
        ledger = StockLedgerEntry.query.filter_by(
            transaction_type="PURCHASE", transaction_id=purchase.id
        ).one()

        assert purchase.remarks == "Corrected bill details"
        assert payable.document_number == "NEW-BILL"
        assert str(payable.due_date) == "2026-06-20"
        assert layer.source_reference == "NEW-BILL"
        assert str(layer.source_date) == "2026-06-02"
        assert ledger.reference_number == "NEW-BILL"
        assert str(ledger.entry_date) == "2026-06-02"


def test_purchase_edit_can_change_total_and_status_to_paid(app):
    with app.app_context():
        data = ids()
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "STATUS-BILL",
                "bill_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()

        update_purchase_header(
            purchase,
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "purchase_type": "GST",
                "supplier_id": data["supplier"].id,
                "bill_number": "STATUS-BILL-PAID",
                "bill_date": "2026-06-02",
                "grand_total": "250",
                "payment_status": "PAID",
            },
            admin(),
        )
        db.session.commit()

        payable = Payable.query.filter_by(source_type="PURCHASE", source_id=purchase.id).one()
        assert purchase.grand_total == 250
        assert purchase.paid_amount == 250
        assert purchase.balance_amount == 0
        assert purchase.payment_status == "PAID"
        assert payable.total_amount == 250
        assert payable.paid_amount == 250
        assert payable.balance_amount == 0
        assert payable.payment_status == "PAID"


def test_purchase_edit_updates_item_quantity_rate_and_stock(app):
    with app.app_context():
        data = ids()
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "LINE-BILL",
                "bill_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()
        line = purchase.lines[0]

        update_purchase_header(
            purchase,
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "purchase_type": "GST",
                "supplier_id": data["supplier"].id,
                "bill_number": "LINE-BILL",
                "bill_date": "2026-06-01",
                "payment_status": "UNPAID",
            },
            admin(),
        )
        update_purchase_lines(
            purchase,
            [{"line_id": line.id, "item_id": data["item"].id, "quantity": "3", "rate": "125", "gst_percent": "18"}],
            {"payment_status": "UNPAID"},
            admin(),
        )
        db.session.commit()

        layer = FIFOLayer.query.filter_by(source_type="PURCHASE", source_id=purchase.id).one()
        ledger = StockLedgerEntry.query.filter_by(transaction_type="PURCHASE", transaction_id=purchase.id).one()
        assert purchase.grand_total == Decimal("442.50")
        assert layer.original_quantity == 3
        assert layer.available_quantity == 3
        assert layer.unit_cost == 125
        assert ledger.quantity_in == 3
        assert ledger.rate == 125
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == 3


def test_purchase_edit_rejects_line_change_after_stock_consumed(app):
    with app.app_context():
        data = ids()
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "CONSUMED-BILL",
                "bill_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "CONSUME-INV",
                "invoice_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()
        line = purchase.lines[0]

        with pytest.raises(ValueError):
            update_purchase_lines(
                purchase,
                [{"line_id": line.id, "item_id": data["item"].id, "quantity": "3", "rate": "100", "gst_percent": "18"}],
                {"payment_status": "UNPAID"},
                admin(),
            )


def test_purchase_edit_page_renders(client, app):
    with app.app_context():
        data = ids()
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "UI-BILL",
                "bill_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()
        purchase_id = purchase.id

    login(client)
    response = client.get(f"/transactions/purchase/{purchase_id}/edit")
    assert response.status_code == 200
    assert b"Edit Purchase" in response.data
    assert b"UI-BILL" in response.data


def test_company_user_sees_edit_for_existing_purchase(client, app):
    with app.app_context():
        data = ids()
        purchase = create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "STOCK-EDIT-BILL",
                "bill_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()
        edit_href = f"/transactions/purchase/{purchase.id}/edit"

    login(client)
    list_response = client.get("/transactions/purchase")
    assert list_response.status_code == 200
    assert edit_href.encode() in list_response.data

    edit_response = client.get(edit_href)
    assert edit_response.status_code == 200
    assert b"STOCK-EDIT-BILL" in edit_response.data
