from app.extensions import db
from app.models import (
    FIFOLayer,
    Item,
    Receivable,
    Sale,
    SaleLine,
    StockBook,
    StockLedgerEntry,
)
from app.services.transactions import (
    create_opening_stock,
    create_sale,
    create_transfer,
    update_sale_header,
    update_sale_lines,
    update_transfer_header,
    void_sale,
)
from tests.test_fifo_workflows import admin, ids
from tests.test_navigation import login
from app.services.stock import available_quantity


def seed_stock(data, reference="EDIT-STOCK"):
    create_opening_stock(
        {
            "company_id": data["ai"].id,
            "stock_book_id": data["ai_gst"].id,
            "reference_number": reference,
            "opening_date": "2026-06-01",
        },
        [{"item_id": data["item"].id, "quantity": "10", "rate": "100"}],
        admin(),
    )


def test_sale_header_edit_updates_receivable_and_ledger(app):
    with app.app_context():
        data = ids()
        seed_stock(data)
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "OLD-INV",
                "invoice_date": "2026-06-02",
                "due_date": "2026-06-20",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()

        update_sale_header(
            sale,
            {
                "customer_id": data["customer"].id,
                "invoice_number": "NEW-INV",
                "invoice_date": "2026-06-03",
                "due_date": "2026-06-25",
                "remarks": "Corrected invoice details",
            },
            admin(),
        )
        db.session.commit()

        sale = Sale.query.filter_by(invoice_number="NEW-INV").one()
        receivable = Receivable.query.filter_by(source_type="SALE", source_id=sale.id).one()
        ledger = StockLedgerEntry.query.filter_by(
            transaction_type="SALE", transaction_id=sale.id
        ).one()

        assert sale.remarks == "Corrected invoice details"
        assert receivable.document_number == "NEW-INV"
        assert str(receivable.due_date) == "2026-06-25"
        assert ledger.reference_number == "NEW-INV"
        assert str(ledger.entry_date) == "2026-06-03"


def test_sale_edit_updates_quantity_rate_totals_and_fifo(app):
    with app.app_context():
        data = ids()
        seed_stock(data, "SALE-LINE-STOCK")
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "LINE-INV",
                "invoice_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()
        line = sale.lines[0]

        update_sale_lines(
            sale,
            [{"line_id": line.id, "item_id": data["item"].id, "quantity": "3", "rate": "200", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()

        assert sale.subtotal == 600
        assert sale.grand_total == 708
        assert sale.fifo_cost == 300
        assert sale.gross_profit == 300
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == 7


def test_cash_sale_forces_zero_gst_on_create_and_edit(app):
    with app.app_context():
        data = ids()
        cash_book = StockBook.query.filter_by(code="AI_CASH").one()
        create_opening_stock(
            {
                "company_id": data["ai"].id,
                "stock_book_id": cash_book.id,
                "reference_number": "CASH-GST-STOCK",
                "opening_date": "2026-06-01",
            },
            [{"item_id": data["item"].id, "quantity": "10", "rate": "100"}],
            admin(),
        )
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": cash_book.id,
                "customer_id": data["customer"].id,
                "sale_type": "CASH",
                "invoice_number": "CASH-GST-INV",
                "invoice_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()
        line = sale.lines[0]

        assert sale.subtotal == 300
        assert sale.gst_total == 0
        assert sale.grand_total == 300
        assert line.gst_percent == 0
        assert line.gst_amount == 0

        update_sale_lines(
            sale,
            [{"line_id": line.id, "item_id": data["item"].id, "quantity": "3", "rate": "200", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()

        assert sale.subtotal == 600
        assert sale.gst_total == 0
        assert sale.grand_total == 600
        assert line.gst_percent == 0
        assert line.gst_amount == 0


def test_sale_edit_can_add_item_line_before_receipt_allocation(app):
    with app.app_context():
        data = ids()
        replacement_item = Item.query.filter_by(code="2").one()
        create_opening_stock(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "reference_number": "SALE-ADD-LINE-STOCK",
                "opening_date": "2026-06-01",
            },
            [
                {"item_id": data["item"].id, "quantity": "10", "rate": "100"},
                {"item_id": replacement_item.id, "quantity": "10", "rate": "80"},
            ],
            admin(),
        )
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "SALE-ADD-LINE",
                "invoice_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "0"}],
            admin(),
        )
        db.session.flush()
        line = sale.lines[0]

        update_sale_lines(
            sale,
            [
                {"line_id": line.id, "item_id": data["item"].id, "quantity": "1", "rate": "100", "gst_percent": "0"},
                {"item_id": replacement_item.id, "quantity": "2", "rate": "50", "gst_percent": "0"},
            ],
            admin(),
        )
        db.session.commit()

        lines = SaleLine.query.filter_by(sale_id=sale.id).order_by(SaleLine.id).all()
        assert len(lines) == 2
        assert sale.grand_total == 200
        assert sale.fifo_cost == 260
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == 9
        assert available_quantity(data["ai"].id, data["ai_gst"].id, replacement_item.id) == 8


def test_sale_edit_can_change_item_before_receipt_allocation(app):
    with app.app_context():
        data = ids()
        replacement_item = Item.query.filter_by(code="2").one()
        create_opening_stock(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "reference_number": "SALE-ITEM-CHANGE-STOCK",
                "opening_date": "2026-06-01",
            },
            [
                {"item_id": data["item"].id, "quantity": "10", "rate": "100"},
                {"item_id": replacement_item.id, "quantity": "6", "rate": "80"},
            ],
            admin(),
        )
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "ITEM-CHANGE-INV",
                "invoice_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()
        line = sale.lines[0]

        update_sale_lines(
            sale,
            [{"line_id": line.id, "item_id": replacement_item.id, "quantity": "3", "rate": "200", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()

        assert line.item_id == replacement_item.id
        assert sale.grand_total == 708
        assert sale.fifo_cost == 240
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == 10
        assert available_quantity(data["ai"].id, data["ai_gst"].id, replacement_item.id) == 3


def test_sale_delete_restores_fifo_stock(app):
    with app.app_context():
        data = ids()
        seed_stock(data, "SALE-DELETE-STOCK")
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "DELETE-INV",
                "invoice_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "2", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.flush()
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == 8

        void_sale(sale, admin())
        db.session.commit()

        assert sale.is_void is True
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == 10
        assert Receivable.query.filter_by(source_type="SALE", source_id=sale.id).count() == 0


def test_company_user_sees_edit_for_existing_sale(client, app):
    with app.app_context():
        data = ids()
        seed_stock(data, "SALES-UI-STOCK")
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "SALES-EDIT-INV",
                "invoice_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()
        edit_href = f"/transactions/sale/{sale.id}/edit"

    login(client)
    list_response = client.get("/transactions/sale")
    assert list_response.status_code == 200
    assert edit_href.encode() in list_response.data

    edit_response = client.get(edit_href)
    assert edit_response.status_code == 200
    assert b"SALES-EDIT-INV" in edit_response.data
    assert b"data-item-search" in edit_response.data
    assert b"data-item-value" in edit_response.data


def test_transfer_header_edit_updates_linked_references(app):
    with app.app_context():
        data = ids()
        seed_stock(data, "TRF-EDIT-STOCK")
        transfer = create_transfer(
            {
                "from_company_id": data["ai"].id,
                "from_stock_book_id": data["ai_gst"].id,
                "to_company_id": data["fml"].id,
                "to_stock_book_id": data["fml_gst"].id,
                "reference_number": "OLD-TRF",
                "transfer_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "2"}],
            admin(),
        )
        db.session.flush()

        update_transfer_header(
            transfer,
            {
                "reference_number": "NEW-TRF",
                "transfer_date": "2026-06-03",
                "reason": "Corrected order reference",
                "remarks": "Corrected transfer details",
            },
            admin(),
        )
        db.session.commit()

        ledger_entries = StockLedgerEntry.query.filter_by(
            transaction_type="TRANSFER", transaction_id=transfer.id
        ).all()

        assert transfer.reference_number == "NEW-TRF"
        assert transfer.reason == "Corrected order reference"
        assert {entry.reference_number for entry in ledger_entries} == {"NEW-TRF"}
        assert {str(entry.entry_date) for entry in ledger_entries} == {"2026-06-03"}
        assert FIFOLayer.query.filter_by(source_type="TRANSFER_IN", source_id=transfer.id).count() == 0


def test_company_user_sees_edit_for_existing_transfer(client, app):
    with app.app_context():
        data = ids()
        seed_stock(data, "TRF-UI-STOCK")
        transfer = create_transfer(
            {
                "from_company_id": data["ai"].id,
                "from_stock_book_id": data["ai_gst"].id,
                "to_company_id": data["fml"].id,
                "to_stock_book_id": data["fml_gst"].id,
                "reference_number": "STOCK-EDIT-TRF",
                "transfer_date": "2026-06-02",
            },
            [{"item_id": data["item"].id, "quantity": "1"}],
            admin(),
        )
        db.session.commit()
        edit_href = f"/transactions/transfer/{transfer.id}/edit"

    login(client)
    list_response = client.get("/transactions/transfer")
    assert list_response.status_code == 200
    assert edit_href.encode() in list_response.data

    edit_response = client.get(edit_href)
    assert edit_response.status_code == 200
    assert b"STOCK-EDIT-TRF" in edit_response.data
