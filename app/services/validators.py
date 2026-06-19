from datetime import datetime, timedelta

from app.core.constants import STOCK_BOOK_CASH, STOCK_BOOK_GST
from app.extensions import db
from app.models import Company, Customer, Item, StockBook, Supplier


def parse_date(value, label):
    if not value:
        raise ValueError(f"{label} is required.")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise ValueError(f"{label} must be a valid date.")


def optional_date(value):
    if not value:
        return None
    return parse_date(value, "Date")


def default_due(base_date, days):
    if days is None:
        return base_date
    return base_date + timedelta(days=int(days))


def active_or_error(model, record_id, label):
    if not record_id:
        raise ValueError(f"{label} is required.")
    record = db.session.get(model, int(record_id))
    if not record:
        raise ValueError(f"{label} was not found.")
    if hasattr(record, "active") and not record.active:
        raise ValueError(f"{label} is inactive.")
    return record


def validate_company_book(company_id, stock_book_id, transaction_type, action_label):
    company = active_or_error(Company, company_id, "Company")
    stock_book = active_or_error(StockBook, stock_book_id, "Stock book")
    transaction_type = (transaction_type or "").upper()
    if stock_book.company_id != company.id:
        raise ValueError("The selected stock book belongs to a different company.")
    if stock_book.book_type != transaction_type:
        readable = "GST" if transaction_type == STOCK_BOOK_GST else "cash"
        raise ValueError(f"{stock_book.name} cannot be used for a {readable} {action_label}.")
    if action_label == "purchase":
        if transaction_type == STOCK_BOOK_GST and not company.allow_gst_purchase:
            raise ValueError(f"{company.code} cannot record GST purchases.")
        if transaction_type == STOCK_BOOK_CASH and not company.allow_cash_purchase:
            raise ValueError(f"{company.code} can record GST purchases only.")
    if action_label == "sale":
        if transaction_type == STOCK_BOOK_GST and not company.allow_gst_sale:
            raise ValueError(f"{company.code} cannot record GST sales.")
        if transaction_type == STOCK_BOOK_CASH and not company.allow_cash_sale:
            raise ValueError(f"{company.code} can record GST sales only.")
    return company, stock_book


def active_item(item_id):
    return active_or_error(Item, item_id, "Item")


def active_supplier(supplier_id):
    return active_or_error(Supplier, supplier_id, "Supplier")


def active_customer(customer_id):
    return active_or_error(Customer, customer_id, "Customer")
