from datetime import date, timedelta
from decimal import Decimal

from flask import Blueprint, jsonify, render_template, request
from flask_login import login_required

from app.core.company_context import active_company
from app.core.security import require_permission
from app.extensions import db
from app.models import (
    Company,
    Item,
    Payable,
    Receivable,
    Sale,
    StockBook,
)
from app.services.stock import available_quantity, available_value
from app.services.calendar_events import build_calendar_events
from app.services.transactions import pending_transfer_summary

bp = Blueprint("dashboard", __name__, url_prefix="/dashboard")


def _date_arg(name, default):
    value = request.args.get(name)
    if not value:
        return default
    try:
        return date.fromisoformat(value)
    except ValueError:
        return default


@bp.route("/")
@login_required
@require_permission("dashboard", "view")
def index():
    company = active_company()
    company_id = company.id if company else None
    stock_books_query = StockBook.query.filter_by(active=True)
    if company_id:
        stock_books_query = stock_books_query.filter(StockBook.company_id == company_id)
    stock_books = stock_books_query.order_by(StockBook.code).all()
    items = Item.query.filter_by(active=True).order_by(Item.code).all()
    stock_cards = []
    for book in stock_books:
        quantity = sum(
            (available_quantity(book.company_id, book.id, item.id) for item in items),
            Decimal("0.000"),
        )
        value = sum(
            (available_value(book.company_id, book.id, item.id) for item in items),
            Decimal("0.00"),
        )
        stock_cards.append({"book": book, "quantity": quantity, "value": value})

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
    )
    receivables = Receivable.query.filter(Receivable.balance_amount > 0)
    payables = Payable.query.filter(Payable.balance_amount > 0)
    if company_id:
        sales_summary = sales_summary.filter(Sale.company_id == company_id)
        receivables = receivables.filter(Receivable.company_id == company_id)
        payables = payables.filter(Payable.company_id == company_id)
    sales_summary = sales_summary.group_by(Company.code, StockBook.book_type).all()
    receivable_total = receivables.with_entities(db.func.coalesce(db.func.sum(Receivable.balance_amount), 0)).scalar()
    payable_total = payables.with_entities(db.func.coalesce(db.func.sum(Payable.balance_amount), 0)).scalar()
    overdue_receivables = receivables.filter(Receivable.due_date < today).order_by(Receivable.due_date).limit(8).all()
    overdue_payables = payables.filter(Payable.due_date < today).order_by(Payable.due_date).limit(8).all()
    upcoming_count = receivables.filter(Receivable.due_date <= today + timedelta(days=7)).count()
    low_stock = []
    for item in items:
        for book in stock_books:
            quantity = (
                available_quantity(book.company_id, book.id, item.id)
            )
            if quantity <= item.minimum_stock:
                low_stock.append({"item": item, "book": book, "quantity": quantity})
    pending_rows = pending_transfer_summary(today)
    if company_id:
        pending_rows = [
            row for row in pending_rows if row["owner"].id == company_id or row["user"].id == company_id
        ]
    inter_company_pending = sum(
        (row["pending"] for row in pending_rows),
        Decimal("0.000"),
    )
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
        inter_company_pending=inter_company_pending,
    )


@bp.route("/calendar-events")
@login_required
@require_permission("dashboard", "view")
def calendar_events():
    today = date.today()
    start = _date_arg("start", today.replace(day=1))
    end = _date_arg("end", start + timedelta(days=40))
    if start > end:
        start, end = end, start
    company = active_company()
    events = build_calendar_events(start, end, company.id if company else None)
    return jsonify({"events": events, "start": start.isoformat(), "end": end.isoformat()})
