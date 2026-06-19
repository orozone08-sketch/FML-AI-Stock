import pytest

from app.extensions import db
from app.models import Company, Customer, Item, Payable, Receivable, StockBook, Supplier, User
from app.services.payments import create_customer_receipt
from app.services.stock import available_quantity
from app.services.transactions import create_opening_stock, create_purchase, create_sale, create_transfer


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


def test_fifo_sale_and_negative_stock_rejection(app):
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

        with pytest.raises(ValueError):
            create_sale(
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


def test_transfer_preserves_fifo_value_and_payment_allocation(app):
    with app.app_context():
        data = ids()
        create_opening_stock(
            {
                "company_id": data["ai"].id,
                "stock_book_id": data["ai_gst"].id,
                "reference_number": "OPN-2",
                "opening_date": "2026-01-01",
            },
            [{"item_id": data["item"].id, "quantity": "5", "rate": "120"}],
            admin(),
        )
        transfer = create_transfer(
            {
                "from_company_id": data["ai"].id,
                "from_stock_book_id": data["ai_gst"].id,
                "to_company_id": data["fml"].id,
                "to_stock_book_id": data["fml_gst"].id,
                "reference_number": "TRF-1",
                "transfer_date": "2026-01-05",
            },
            [{"item_id": data["item"].id, "quantity": "2"}],
            admin(),
        )
        db.session.commit()
        assert transfer.total_fifo_value == 240
        assert available_quantity(data["fml"].id, data["fml_gst"].id, data["item"].id) == 2
        assert Payable.query.filter_by(source_type="INTER_COMPANY").first().balance_amount == 240

        sale = create_sale(
            {
                "company_id": data["fml"].id,
                "stock_book_id": data["fml_gst"].id,
                "customer_id": data["customer"].id,
                "sale_type": "GST",
                "invoice_number": "FML-INV-1",
                "invoice_date": "2026-01-06",
            },
            [{"item_id": data["item"].id, "quantity": "1", "rate": "200", "gst_percent": "18"}],
            admin(),
        )
        db.session.commit()
        receivable = Receivable.query.filter_by(source_type="SALE", source_id=sale.id).first()
        payment = create_customer_receipt(
            {
                "company_id": data["fml"].id,
                "customer_id": data["customer"].id,
                "receivable_id": receivable.id,
                "payment_date": "2026-01-07",
                "mode": "CASH",
                "amount": "236",
            },
            admin(),
        )
        db.session.commit()
        assert payment.unallocated_amount == 0
        assert receivable.payment_status == "PAID"
