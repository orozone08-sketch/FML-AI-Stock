import pytest

from app.extensions import db
from app.models import Company, Customer, Item, StockBook, Supplier, User
from app.services.stock import available_quantity
from app.services.transactions import (
    create_opening_stock,
    create_purchase,
    create_sale,
    create_transfer,
    pending_transfer_quantity,
    void_transfer,
)


def admin():
    return User.query.filter_by(role="ADMIN").first()


def ids():
    return {
        "fml": Company.query.filter_by(code="FML").first(),
        "ai": Company.query.filter_by(code="AI").first(),
        "fml_gst": StockBook.query.filter_by(code="FML_GST").first(),
        "ai_gst": StockBook.query.filter_by(code="AI_GST").first(),
        "item": Item.query.filter_by(code="1").first(),
        "supplier": Supplier.query.filter_by(code="NC").first(),
        "customer": Customer.query.first(),
    }


def test_fifo_sale_allows_negative_stock(app):
    with app.app_context():
        data = ids()
        create_opening_stock(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "reference_number": "OPN-1",
                "opening_date": "2026-01-01",
            },
            [{"item_id": data["item"].id, "quantity": "10", "rate": "100"}],
            admin(),
        )
        create_purchase(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "supplier_id": data["supplier"].id,
                "purchase_type": "GST",
                "bill_number": "BILL-1",
                "bill_date": "2026-01-02",
            },
            [{"item_id": data["item"].id, "quantity": "20", "rate": "120", "gst_percent": "18"}],
            admin(),
        )
        sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "INV-1",
                "invoice_date": "2026-01-03",
            },
            [{"item_id": data["item"].id, "quantity": "15", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()
        assert sale.fifo_cost == 1600
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == 15

        negative_sale = create_sale(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "INV-OVER",
                "invoice_date": "2026-01-04",
            },
            [{"item_id": data["item"].id, "quantity": "99", "rate": "150", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()

        assert negative_sale.fifo_cost == 1800
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == -84


def test_transfer_issue_return_and_pending_balance(app):
    with app.app_context():
        data = ids()
        create_opening_stock(
            {
                "company_id": data["fml"].id,
                "stock_book_id": data["fml_gst"].id,
                "reference_number": "OPN-2",
                "opening_date": "2026-01-01",
            },
            [{"item_id": data["item"].id, "quantity": "5", "rate": "120"}],
            admin(),
        )
        transfer = create_transfer(
            {
                "from_company_id": data["fml"].id,
                "from_stock_book_id": data["fml_gst"].id,
                "to_company_id": data["ai"].id,
                "to_stock_book_id": data["ai_gst"].id,
                "reference_number": "TRF-1",
                "transfer_date": "2026-01-05",
            },
            [{"item_id": data["item"].id, "quantity": "2"}],
            admin(),
        )
        db.session.commit()
        assert transfer.total_fifo_value == 240
        assert available_quantity(data["fml"].id, data["fml_gst"].id, data["item"].id) == 3
        assert available_quantity(data["ai"].id, data["ai_gst"].id, data["item"].id) == 0
        assert pending_transfer_quantity(data["fml"].id, data["ai"].id, data["item"].id) == 2

        returned = create_transfer(
            {
                "from_company_id": data["ai"].id,
                "from_stock_book_id": data["ai_gst"].id,
                "to_company_id": data["fml"].id,
                "to_stock_book_id": data["fml_gst"].id,
                "reference_number": "TRF-RET-1",
                "invoice_date": "2026-01-06",
                "transfer_date": "2026-01-06",
            },
            [{"item_id": data["item"].id, "quantity": "1"}],
            admin(),
        )
        db.session.commit()
        assert returned.total_fifo_value == 120
        assert available_quantity(data["fml"].id, data["fml_gst"].id, data["item"].id) == 4
        assert pending_transfer_quantity(data["fml"].id, data["ai"].id, data["item"].id) == 1

        with pytest.raises(ValueError):
            create_transfer(
                {
                    "from_company_id": data["ai"].id,
                    "from_stock_book_id": data["ai_gst"].id,
                    "to_company_id": data["fml"].id,
                    "to_stock_book_id": data["fml_gst"].id,
                    "reference_number": "TRF-RET-OVER",
                    "transfer_date": "2026-01-07",
                },
                [{"item_id": data["item"].id, "quantity": "2"}],
                admin(),
            )


def test_transfer_return_delete_reverses_warehouse_and_pending(app):
    with app.app_context():
        data = ids()
        create_opening_stock(
            {
                "company_id": data["fml"].id,
                "stock_book_id": data["fml_gst"].id,
                "reference_number": "OPN-RETURN-DELETE",
                "opening_date": "2026-01-01",
            },
            [{"item_id": data["item"].id, "quantity": "5", "rate": "120"}],
            admin(),
        )
        issue = create_transfer(
            {
                "from_company_id": data["fml"].id,
                "from_stock_book_id": data["fml_gst"].id,
                "to_company_id": data["ai"].id,
                "to_stock_book_id": data["ai_gst"].id,
                "reference_number": "TRF-DELETE-ISSUE",
                "transfer_date": "2026-01-05",
            },
            [{"item_id": data["item"].id, "quantity": "2"}],
            admin(),
        )
        returned = create_transfer(
            {
                "from_company_id": data["ai"].id,
                "from_stock_book_id": data["ai_gst"].id,
                "to_company_id": data["fml"].id,
                "to_stock_book_id": data["fml_gst"].id,
                "reference_number": "TRF-DELETE-RETURN",
                "transfer_date": "2026-01-06",
            },
            [{"item_id": data["item"].id, "quantity": "1"}],
            admin(),
        )
        db.session.flush()
        assert available_quantity(data["fml"].id, data["fml_gst"].id, data["item"].id) == 4
        assert pending_transfer_quantity(data["fml"].id, data["ai"].id, data["item"].id) == 1

        with pytest.raises(ValueError):
            void_transfer(issue, admin())

        void_transfer(returned, admin())
        db.session.commit()

        assert returned.is_void is True
        assert available_quantity(data["fml"].id, data["fml_gst"].id, data["item"].id) == 3
        assert pending_transfer_quantity(data["fml"].id, data["ai"].id, data["item"].id) == 2
