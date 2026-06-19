from datetime import date, timedelta
from decimal import Decimal

from flask import Blueprint, render_template
from flask_login import login_required

from app.core.security import require_permission
from app.extensions import db
from app.models import (
    Company,
    FIFOLayer,
    InterCompanyLedgerEntry,
    Item,
    Payable,
    Receivable,
    Sale,
    StockBook,
)

bp = Blueprint("dashboard", __name__, url_prefix="/dashboard")


@bp.route("/")
@login_required
@require_permission("dashboard", "view")
def index():
    stock_books = StockBook.query.filter_by(active=True).order_by(StockBook.code).all()
    stock_cards = []
    for book in stock_books:
        quantity, value = (
            db.session.query(
                db.func.coalesce(db.func.sum(FIFOLayer.available_quantity), 0),
                db.func.coalesce(db.func.sum(FIFOLayer.available_value), 0),
            )
            .filter(FIFOLayer.stock_book_id == book.id, FIFOLayer.available_quantity > 0)
            .first()
        )
        stock_cards.append({"book": book, "quantity": quantity or Decimal("0"), "value": value or Decimal("0")})

    today = date.today()
    month_start = today.replace(day=1)
    sales_summary = (
        db.session.query(
            Company.code,
            StockBook.book_type,
            db.func.coalesce(db.func.sum(Sale.grand_total), 0),
            db.func.coalesce(db.func.sum(Sale.gross_profit), 0),
        )
        .join(Company, Sale.company_id == Company.id)
        .join(StockBook, Sale.stock_book_id == StockBook.id)
        .filter(Sale.invoice_date >= month_start, Sale.is_void.is_(False))
        .group_by(Company.code, StockBook.book_type)
        .all()
    )
    receivable_total = db.session.query(db.func.coalesce(db.func.sum(Receivable.balance_amount), 0)).filter(Receivable.balance_amount > 0).scalar()
    payable_total = db.session.query(db.func.coalesce(db.func.sum(Payable.balance_amount), 0)).filter(Payable.balance_amount > 0).scalar()
    overdue_receivables = Receivable.query.filter(Receivable.balance_amount > 0, Receivable.due_date < today).order_by(Receivable.due_date).limit(8).all()
    overdue_payables = Payable.query.filter(Payable.balance_amount > 0, Payable.due_date < today).order_by(Payable.due_date).limit(8).all()
    upcoming_count = Receivable.query.filter(Receivable.balance_amount > 0, Receivable.due_date <= today + timedelta(days=7)).count()
    low_stock = []
    for item in Item.query.filter_by(active=True).all():
        for book in stock_books:
            quantity = (
                db.session.query(db.func.coalesce(db.func.sum(FIFOLayer.available_quantity), 0))
                .filter(
                    FIFOLayer.stock_book_id == book.id,
                    FIFOLayer.item_id == item.id,
                    FIFOLayer.available_quantity > 0,
                )
                .scalar()
            ) or Decimal("0")
            if quantity <= item.minimum_stock:
                low_stock.append({"item": item, "book": book, "quantity": quantity})
    inter_company_balance = db.session.query(db.func.coalesce(db.func.sum(InterCompanyLedgerEntry.balance_amount), 0)).filter(InterCompanyLedgerEntry.balance_amount > 0).scalar()
    return render_template(
        "dashboard/index.html",
        stock_cards=stock_cards,
        sales_summary=sales_summary,
        receivable_total=receivable_total,
        payable_total=payable_total,
        overdue_receivables=overdue_receivables,
        overdue_payables=overdue_payables,
        upcoming_count=upcoming_count,
        low_stock=low_stock[:8],
        low_stock_count=len(low_stock),
        inter_company_balance=inter_company_balance,
    )
