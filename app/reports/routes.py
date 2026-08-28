from datetime import date, timedelta
from decimal import Decimal

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from app.core.company_context import active_company
from app.core.formatting import fmt_money, fmt_qty, money, qty
from app.core.security import can, require_permission
from app.extensions import db
from app.models import (
    AuditLog,
    Company,
    Customer,
    FIFOLayer,
    Item,
    Payable,
    Payment,
    Purchase,
    PurchaseLine,
    Receivable,
    Sale,
    SaleLine,
    StockBook,
    StockLedgerEntry,
    User,
)
from app.reports.exporting import export_table
from app.services.customer_ledger import (
    customer_ledger_entries,
    ledger_detail,
    ledger_metrics,
    monthly_customer_summary,
)
from app.services.item_ledger import item_ledger as build_item_ledger
from app.services.outstanding import grouped_party_outstanding
from app.services.stock import available_quantity, available_value
from app.services.transactions import pending_transfer_summary

bp = Blueprint("reports", __name__, url_prefix="/reports")


REPORT_TITLES = {
    "current-stock": "Current Stock Report",
    "stock-list": "Stock List",
    "fifo-valuation": "FIFO Valuation Report",
    "fifo-layers": "FIFO Layer Detail",
    "stock-ledger": "Stock Ledger",
    "item-ledger": "Item Movement Ledger",
    "purchases": "Purchase Report",
    "purchases-monthly": "Monthly Purchase Report",
    "sales": "Sales Report",
    "sales-monthly": "Monthly Sales Report",
    "sales-by-type": "Sales by Company and Type",
    "customer-ledger": "Customer Ledger",
    "gross-profit": "Gross Profit Report",
    "customer-outstanding": "Customer Outstanding",
    "supplier-outstanding": "Supplier Outstanding",
    "advances": "Advances Received/Paid",
    "payment-history": "Payment History",
    "due-alerts": "Due and Overdue Report",
    "stock-alerts": "Low Stock and Stock-Out Report",
    "inter-company": "Inter-Company Usage and Balance",
    "opening-summary": "Opening Balance Summary",
    "purchase-price-fluctuation": "Purchase Price Fluctuation",
    "sale-price-fluctuation": "Sale Price Fluctuation",
    "audit": "User and Audit Report",
}


def active_report_company_id():
    company = active_company()
    return company.id if company else None


def scope_query_to_active_company(query, column):
    company_id = active_report_company_id()
    if company_id:
        return query.filter(column == company_id)
    return query


def in_active_company_scope(*company_ids):
    company_id = active_report_company_id()
    return not company_id or company_id in company_ids


def creator_name(user_id):
    if not user_id:
        return "System"
    user = db.session.get(User, int(user_id))
    return user.name if user else "Unknown user"


def parse_money_cell(value):
    text = str(value)
    if "₹" not in text:
        return None
    try:
        return money(text.replace("₹", ""))
    except ValueError:
        return None


def report_totals(headers, rows):
    totals = []
    for index, header in enumerate(headers):
        if header.lower() in {"rate", "rate (ex gst)", "gst %", "margin %"}:
            continue
        total = Decimal("0.00")
        has_money = False
        for row in rows:
            if index >= len(row):
                continue
            amount = parse_money_cell(row[index])
            if amount is None:
                continue
            total = money(total + amount)
            has_money = True
        if has_money:
            totals.append({"label": header, "value": fmt_money(total), "column": index})
    return totals


@bp.route("/")
@login_required
@require_permission("reports", "view")
def index():
    return render_template("reports/index.html", reports=REPORT_TITLES)


def int_arg(name):
    value = request.args.get(name)
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def date_arg(name):
    value = request.args.get(name)
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def month_bounds():
    value = (request.args.get("month") or "").strip()
    if len(value) != 7:
        return None, None
    try:
        start = date.fromisoformat(f"{value}-01")
    except ValueError:
        return None, None
    next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return start, next_month


def selected_report_company_id():
    company = active_company()
    if company:
        return company.id
    return int_arg("company_id")


def customer_ledger_filters():
    company = active_company()
    companies = Company.query.filter_by(active=True)
    if company:
        companies = companies.filter(Company.id == company.id)
    return {
        "companies": companies.order_by(Company.code).all(),
        "customers": Customer.query.filter_by(active=True).order_by(Customer.code).all(),
        "selected_company_id": selected_report_company_id(),
        "selected_customer_id": int_arg("customer_id"),
    }


def customer_ledger_summary_rows(summary):
    return [
        [
            row["company"],
            row["customer"],
            row["month"],
            row["bills"],
            fmt_money(row["debit"]),
            fmt_money(row["credit"]),
            fmt_money(row["closing"]),
        ]
        for row in summary
    ]


def customer_ledger_detail_rows(detail):
    rows = [["", "Opening Balance", "", "", "", "", fmt_money(detail["opening"])]]
    for row in detail["rows"]:
        rows.append(
            [
                row["date"],
                row["particulars"],
                row["voucher_type"],
                row["voucher_no"],
                fmt_money(row["debit"]),
                fmt_money(row["credit"]),
                fmt_money(row["balance"]),
            ]
        )
    rows.append(["", "Closing Balance", "", "", "", "", fmt_money(detail["closing"])])
    return rows


def item_ledger_filters():
    company = active_company()
    companies = Company.query.filter_by(active=True)
    if company:
        companies = companies.filter(Company.id == company.id)
    selected_company_id = selected_report_company_id()
    selected_stock_book_id = int_arg("stock_book_id")
    selected_item_id = int_arg("item_id")
    if not selected_item_id:
        first_item = Item.query.filter_by(active=True).order_by(Item.code).first()
        selected_item_id = first_item.id if first_item else None
    stock_books = StockBook.query.filter_by(active=True)
    if selected_company_id:
        stock_books = stock_books.filter(StockBook.company_id == selected_company_id)
    return {
        "companies": companies.order_by(Company.code).all(),
        "stock_books": stock_books.order_by(StockBook.code).all(),
        "items": Item.query.filter_by(active=True).order_by(Item.code).all(),
        "selected_company_id": selected_company_id,
        "selected_stock_book_id": selected_stock_book_id,
        "selected_item_id": selected_item_id,
        "date_from": date_arg("date_from"),
        "date_to": date_arg("date_to"),
        "highlight_id": int_arg("highlight_id"),
    }


ITEM_LEDGER_HEADERS = [
    "Date",
    "Particulars",
    "Party type",
    "Voucher type",
    "Voucher no",
    "Inwards qty",
    "Inwards value",
    "Outwards qty",
    "Outwards value",
    "Voucher amount",
    "Closing qty",
    "Closing value",
]


def item_ledger_rows(rows):
    return [
        [
            row["date"],
            row["particulars"],
            row["party_kind"],
            row["voucher_type"],
            row["voucher_no"],
            fmt_qty(row["inward_qty"]),
            fmt_money(row["inward_value"]),
            fmt_qty(row["outward_qty"]),
            fmt_money(row["outward_value"]),
            fmt_money(row["voucher_amount"]),
            fmt_qty(row["closing_qty"]),
            fmt_money(row["closing_value"]),
        ]
        for row in rows
    ]


def export_urls_for(endpoint):
    urls = {}
    for fmt in ("csv", "xlsx", "pdf"):
        args = request.args.to_dict()
        args["format"] = fmt
        urls[fmt] = url_for(endpoint, **args)
    return urls


@bp.route("/item-ledger")
@login_required
@require_permission("reports", "view")
def item_ledger():
    filters = item_ledger_filters()
    ledger = build_item_ledger(
        filters["selected_item_id"],
        filters["selected_company_id"],
        filters["selected_stock_book_id"],
        filters["date_from"],
        filters["date_to"],
        filters["highlight_id"],
    )
    export_format = request.args.get("format")
    selected_item = db.session.get(Item, filters["selected_item_id"]) if filters["selected_item_id"] else None
    if export_format:
        require_permission("reports", "export")(lambda: None)()
        title = f"Item Movement Ledger - {selected_item.display_name if selected_item else 'All Items'}"
        return export_table(title, ITEM_LEDGER_HEADERS, item_ledger_rows(ledger["rows"]), export_format)
    return render_template(
        "reports/item_ledger.html",
        ledger=ledger,
        selected_item=selected_item,
        export_urls=export_urls_for("reports.item_ledger"),
        **filters,
    )


@bp.route("/customer-ledger")
@login_required
@require_permission("reports", "view")
def customer_ledger():
    filters = customer_ledger_filters()
    entries = customer_ledger_entries(filters["selected_company_id"], filters["selected_customer_id"])
    summary = monthly_customer_summary(entries)
    metrics = ledger_metrics(entries)
    export_format = request.args.get("format")
    if export_format:
        require_permission("reports", "export")(lambda: None)()
        headers = ["Company", "Customer", "Month", "Bills", "Debit", "Credit", "Closing balance"]
        return export_table("Customer Ledger", headers, customer_ledger_summary_rows(summary), export_format)
    return render_template(
        "reports/customer_ledger.html",
        summary=summary,
        metrics=metrics,
        **filters,
    )


@bp.route("/customer-ledger/detail")
@login_required
@require_permission("reports", "view")
def customer_ledger_detail():
    company_id = selected_report_company_id()
    customer_id = int_arg("customer_id")
    month = request.args.get("month") or ""
    active = active_company()
    if active and company_id != active.id:
        abort(403)
    if not company_id or not customer_id or len(month) != 7:
        flash("Select a valid customer ledger month.", "danger")
        return redirect(url_for("reports.customer_ledger"))
    try:
        entries = customer_ledger_entries(company_id, customer_id)
        detail = ledger_detail(entries, company_id, customer_id, month)
    except ValueError:
        flash("Select a valid customer ledger month.", "danger")
        return redirect(url_for("reports.customer_ledger"))
    if not detail["rows"]:
        flash("No ledger entries found for that month.", "warning")
        return redirect(url_for("reports.customer_ledger", company_id=company_id, customer_id=customer_id))
    company = db.session.get(Company, company_id)
    customer = db.session.get(Customer, customer_id)
    if not company or not customer:
        flash("Customer ledger selection was not found.", "danger")
        return redirect(url_for("reports.customer_ledger"))
    export_format = request.args.get("format")
    if export_format:
        require_permission("reports", "export")(lambda: None)()
        headers = ["Date", "Particulars", "Voucher type", "Voucher no", "Debit", "Credit", "Balance"]
        return export_table(
            f"{customer.name} Ledger {detail['month_label']}",
            headers,
            customer_ledger_detail_rows(detail),
            export_format,
        )
    return render_template(
        "reports/customer_ledger_detail.html",
        company=company,
        customer=customer,
        detail=detail,
    )


@bp.route("/<name>")
@login_required
@require_permission("reports", "view")
def show(name):
    if name not in REPORT_TITLES:
        flash("Unknown report.", "danger")
        return redirect(url_for("reports.index"))
    title = REPORT_TITLES[name]
    if name in {"sales", "purchases"} and request.args.get("month"):
        title = f"{title} - {request.args['month']}"
    headers, rows = build_report(name)
    export_format = request.args.get("format")
    if export_format:
        require_permission("reports", "export")(lambda: None)()
        return export_table(title, headers, rows, export_format)
    return render_template(
        "reports/table.html",
        title=title,
        headers=headers,
        rows=rows,
        row_actions=report_row_actions(name, rows),
        month_detail_urls=monthly_detail_urls(name, rows),
        reports=REPORT_TITLES,
        totals=report_totals(headers, rows),
    )


def stock_list_data(
    selected_company_id=None,
    selected_stock_book_id=None,
    selected_item_id=None,
    period_start=None,
    period_end=None,
):
    """Return item-level stock totals and optional stock-book detail.

    Received and sold are movements during the selected period. Pending and
    available are the closing ledger balance at the end of that period, so
    opening stock, purchases, transfers, and all stock-out movements reconcile
    correctly.
    """
    books_query = StockBook.query.filter_by(active=True)
    if active_company():
        books_query = books_query.filter(StockBook.company_id == active_company().id)
    if selected_company_id:
        books_query = books_query.filter(StockBook.company_id == selected_company_id)
    if selected_stock_book_id:
        books_query = books_query.filter(StockBook.id == selected_stock_book_id)
    books = books_query.order_by(StockBook.code).all()
    items = Item.query.order_by(Item.code).all()

    by_book_item = {
        (book.company_id, book.id, item.id): {
            "company_id": book.company_id,
            "stock_book_id": book.id,
            "item_id": item.id,
            "received": Decimal("0.000"),
            "sold": Decimal("0.000"),
            "pending": Decimal("0.000"),
            "fifo_value": Decimal("0.00"),
        }
        for book in books
        for item in items
    }
    entry_query = StockLedgerEntry.query
    if selected_company_id:
        entry_query = entry_query.filter(StockLedgerEntry.company_id == selected_company_id)
    if selected_stock_book_id:
        entry_query = entry_query.filter(StockLedgerEntry.stock_book_id == selected_stock_book_id)
    for entry in entry_query.order_by(StockLedgerEntry.entry_date, StockLedgerEntry.id).all():
        key = (entry.company_id, entry.stock_book_id, entry.item_id)
        aggregate = by_book_item.get(key)
        if not aggregate:
            continue
        if period_end and entry.entry_date >= period_end:
            continue
        inward = qty(entry.quantity_in)
        outward = qty(entry.quantity_out)
        aggregate["pending"] += inward - outward
        aggregate["fifo_value"] += money(entry.value if entry.movement_type == "IN" else -entry.value)
        if not period_start or entry.entry_date >= period_start:
            aggregate["received"] += inward
            if entry.transaction_type == "SALE":
                aggregate["sold"] += outward

    book_lookup = {(book.company_id, book.id): book for book in books}
    item_lookup = {item.id: item for item in items}
    by_item = {}
    for key, aggregate in by_book_item.items():
        company_id, stock_book_id, item_id = key
        item = item_lookup[item_id]
        row = by_item.setdefault(
            (company_id, item_id),
            {
                "company_id": company_id,
                "item_id": item_id,
                "item": item,
                "received": Decimal("0.000"),
                "sold": Decimal("0.000"),
                "pending": Decimal("0.000"),
                "fifo_value": Decimal("0.00"),
                "book_count": 0,
            },
        )
        row["received"] += aggregate["received"]
        row["sold"] += aggregate["sold"]
        row["pending"] += aggregate["pending"]
        row["fifo_value"] += aggregate["fifo_value"]
        row["book_count"] += 1

    def status_for(row):
        if row["pending"] < Decimal("0.000"):
            return "NEGATIVE"
        if row["pending"] == Decimal("0.000"):
            return "OUT"
        if row["pending"] <= qty(row["item"].minimum_stock):
            return "LOW"
        return "NORMAL"

    rows = []
    for row in sorted(by_item.values(), key=lambda value: (value["item"].code, value["company_id"])):
        row["company"] = db.session.get(Company, row["company_id"])
        row["status"] = status_for(row)
        rows.append(row)

    selected_summary = {
        "received": Decimal("0.000"),
        "sold": Decimal("0.000"),
        "pending": Decimal("0.000"),
        "fifo_value": Decimal("0.00"),
    }
    selected_book_rows = []
    if selected_item_id:
        selected_rows = [row for row in rows if row["item_id"] == selected_item_id]
        for row in selected_rows:
            for field in selected_summary:
                selected_summary[field] += row[field]
        for key, aggregate in by_book_item.items():
            company_id, stock_book_id, item_id = key
            if item_id != selected_item_id:
                continue
            book = book_lookup.get((company_id, stock_book_id))
            if not book:
                continue
            detail = dict(aggregate)
            detail["company"] = db.session.get(Company, company_id)
            detail["stock_book"] = book
            detail["status"] = status_for({**detail, "item": item_lookup[item_id]})
            selected_book_rows.append(detail)
        selected_book_rows.sort(key=lambda row: (row["company"].code, row["stock_book"].code))

    return rows, selected_summary, selected_book_rows


@bp.route("/stock-list")
@login_required
@require_permission("reports", "view")
def stock_list():
    selected_company_id = selected_report_company_id()
    selected_stock_book_id = int_arg("stock_book_id")
    selected_item_id = int_arg("item_id")
    period_start, period_end = month_bounds()
    selected_month = request.args.get("month") if period_start else ""
    companies_query = Company.query.filter_by(active=True)
    if active_company():
        companies_query = companies_query.filter(Company.id == active_company().id)
    companies = companies_query.order_by(Company.code).all()
    stock_books_query = StockBook.query.filter_by(active=True)
    if selected_company_id:
        stock_books_query = stock_books_query.filter(StockBook.company_id == selected_company_id)
    stock_books = stock_books_query.order_by(StockBook.code).all()
    valid_book_ids = {book.id for book in stock_books}
    if selected_stock_book_id and selected_stock_book_id not in valid_book_ids:
        selected_stock_book_id = None
    items = Item.query.order_by(Item.code).all()
    valid_item_ids = {item.id for item in items}
    if selected_item_id not in valid_item_ids:
        selected_item_id = None
    rows, selected_summary, selected_book_rows = stock_list_data(
        selected_company_id,
        selected_stock_book_id,
        selected_item_id,
        period_start,
        period_end,
    )
    search = (request.args.get("q") or "").strip().casefold()
    if search:
        rows = [
            row
            for row in rows
            if search in row["item"].display_name.casefold()
            or search in row["item"].code.casefold()
            or search in row["company"].code.casefold()
        ]
    selected_item = db.session.get(Item, selected_item_id) if selected_item_id else None
    return render_template(
        "reports/stock_list.html",
        rows=rows,
        companies=companies,
        stock_books=stock_books,
        items=items,
        selected_company_id=selected_company_id,
        selected_stock_book_id=selected_stock_book_id,
        selected_item_id=selected_item_id,
        selected_item=selected_item,
        selected_summary=selected_summary,
        selected_book_rows=selected_book_rows,
        selected_month=selected_month,
    )


def monthly_detail_urls(name, rows):
    if name not in {"sales-monthly", "purchases-monthly"}:
        return []
    detail_name = "sales" if name == "sales-monthly" else "purchases"
    company_ids = {company.code: company.id for company in Company.query.all()}
    return [
        url_for(
            "reports.show",
            name=detail_name,
            month=row[0],
            company_id=company_ids.get(row[1]),
        )
        for row in rows
    ]


def report_row_actions(name, rows):
    if name == "purchases":
        return [
            source_document_actions("PURCHASE", purchase.id)
            for purchase in purchase_report_query().order_by(Purchase.bill_date.desc(), Purchase.id.desc()).all()
        ]
    if name == "sales":
        actions = []
        emitted_sales = set()
        for line in sale_report_lines_query().order_by(
            Sale.invoice_date.desc(), Sale.id.desc(), SaleLine.id.asc()
        ).all():
            if line.sale.id in emitted_sales:
                actions.append([])
                continue
            emitted_sales.add(line.sale.id)
            actions.append(source_document_actions("SALE", line.sale.id))
        return actions
    if name in {"purchases-monthly", "sales-monthly"}:
        detail_name = "sales" if name == "sales-monthly" else "purchases"
        detail_urls = monthly_detail_urls(name, rows)
        return [
            [{"label": "Open full report", "url": detail_url, "title": f"Open {detail_name} for this month"}]
            for detail_url in detail_urls
        ]
    if name == "sales-by-type":
        company_ids = {company.code: company.id for company in Company.query.all()}
        return [
            [{
                "label": "Open sales",
                "url": url_for(
                    "reports.show",
                    name="sales",
                    company_id=company_ids.get(row[0]),
                    sale_type=row[1],
                ),
                "title": "Open the matching sales records",
            }]
            for row in rows
        ]
    if name == "fifo-layers":
        query = scope_query_to_active_company(FIFOLayer.query, FIFOLayer.company_id)
        layers = query.order_by(FIFOLayer.source_date, FIFOLayer.id).all()
        history_actions = stock_item_history_actions(rows, company_index=0, stock_book_index=1, item_index=2, item_mode="display")
        return [
            source_document_actions(layer.source_type, layer.source_id) + history_actions[index]
            for index, layer in enumerate(layers)
        ]
    if name == "stock-ledger":
        query = scope_query_to_active_company(StockLedgerEntry.query, StockLedgerEntry.company_id)
        entries = query.order_by(StockLedgerEntry.entry_date, StockLedgerEntry.id).all()
        history_actions = stock_item_history_actions(rows, company_index=1, stock_book_index=2, item_index=3, item_mode="display")
        return [
            source_document_actions(entry.transaction_type, entry.transaction_id) + history_actions[index]
            for index, entry in enumerate(entries)
        ]
    if name == "gross-profit":
        query = scope_query_to_active_company(
            SaleLine.query.join(Sale).filter(Sale.is_void.is_(False)),
            Sale.company_id,
        )
        lines = query.order_by(Sale.invoice_date.desc()).all()
        return [source_document_actions("SALE", line.sale.id) for line in lines]
    if name in {"advances", "payment-history"}:
        query = Payment.query
        if name == "advances":
            query = query.filter(Payment.unallocated_amount > 0)
        query = scope_query_to_active_company(query, Payment.company_id)
        payments = query.order_by(Payment.payment_date.desc(), Payment.id.desc()).all()
        return [payment_actions(payment) for payment in payments]
    if name == "due-alerts":
        return due_alert_actions()
    if name == "opening-summary":
        return opening_summary_actions()
    if name in {"current-stock", "fifo-valuation"}:
        return stock_item_history_actions(rows, company_index=0, stock_book_index=1, item_index=2, item_mode="code")
    if name == "stock-alerts":
        return stock_item_history_actions(rows, company_index=1, stock_book_index=2, item_index=3, item_mode="display")
    return [[] for _ in rows]


def action_pair(edit_endpoint, edit_args, delete_endpoint, delete_args, module, label):
    actions = []
    if can(current_user, module, "edit") or can(current_user, module, "create"):
        actions.append({
            "label": "Edit",
            "url": url_for(edit_endpoint, **edit_args),
            "title": f"Edit this {label}",
        })
    if can(current_user, module, "edit") or can(current_user, module, "deactivate"):
        actions.append({
            "label": "Delete",
            "method": "post",
            "url": url_for(delete_endpoint, **delete_args),
            "confirm": f"Delete this {label}?",
            "title": f"Delete this {label}",
            "button_class": "danger-link",
        })
    return actions


def source_document_actions(source_type, source_id):
    mappings = {
        "PURCHASE": ("transactions.purchase_edit", {"purchase_id": source_id}, "transactions.purchase_delete", {"purchase_id": source_id}, "purchase", "purchase"),
        "SALE": ("transactions.sale_edit", {"sale_id": source_id}, "transactions.sale_delete", {"sale_id": source_id}, "sale", "sale"),
        "TRANSFER": ("transactions.transfer_edit", {"transfer_id": source_id}, "transactions.transfer_delete", {"transfer_id": source_id}, "transfer", "transfer"),
        "TRANSFER_IN": ("transactions.transfer_edit", {"transfer_id": source_id}, "transactions.transfer_delete", {"transfer_id": source_id}, "transfer", "transfer"),
        "TRANSFER_RETURN": ("transactions.transfer_edit", {"transfer_id": source_id}, "transactions.transfer_delete", {"transfer_id": source_id}, "transfer", "transfer"),
        "OPENING_STOCK": ("transactions.opening_stock_edit", {"opening_id": source_id}, "transactions.opening_stock_delete", {"opening_id": source_id}, "opening", "opening stock"),
        "OPENING_RECEIVABLE": ("transactions.opening_receivable_edit", {"receivable_id": source_id}, "transactions.opening_receivable_delete", {"receivable_id": source_id}, "opening", "opening receivable"),
        "OPENING_PAYABLE": ("transactions.opening_payable_edit", {"payable_id": source_id}, "transactions.opening_payable_delete", {"payable_id": source_id}, "opening", "opening payable"),
        "INTER_COMPANY": ("transactions.transfer_edit", {"transfer_id": source_id}, "transactions.transfer_delete", {"transfer_id": source_id}, "transfer", "transfer"),
    }
    mapping = mappings.get(source_type)
    if not mapping:
        return []
    actions = action_pair(*mapping)
    if source_type == "OPENING_RECEIVABLE":
        receivable = db.session.get(Receivable, source_id)
        if receivable and receivable.paid_amount and (can(current_user, "opening", "edit") or can(current_user, "opening", "create")):
            actions.append({
                "label": "Restore Pending",
                "method": "post",
                "url": url_for("transactions.opening_receivable_restore_pending", receivable_id=source_id),
                "confirm": "Reverse allocations for this opening receivable and restore its full pending balance?",
                "title": "Restore this opening receivable as pending",
                "button_class": "link-button",
            })
    return actions


def payment_actions(payment):
    if payment.payment_type.startswith("OPENING_ADVANCE"):
        return action_pair(
            "transactions.opening_advance_edit",
            {"payment_id": payment.id},
            "transactions.opening_advance_delete",
            {"payment_id": payment.id},
            "opening",
            "opening advance",
        )
    actions = []
    if can(current_user, "payments", "edit") or can(current_user, "payments", "deactivate"):
        actions.append({
            "label": "Edit",
            "url": url_for("payments.payment_edit", payment_id=payment.id),
            "title": "Edit this payment",
        })
        actions.append({
            "label": "Delete",
            "method": "post",
            "url": url_for("payments.payment_delete", payment_id=payment.id),
            "confirm": "Delete this payment and reverse its allocation?",
            "title": "Delete this payment",
            "button_class": "danger-link",
        })
    return actions


def due_alert_actions():
    today = date.today()
    receivables = scope_query_to_active_company(
        Receivable.query.filter(Receivable.balance_amount > 0),
        Receivable.company_id,
    )
    payables = scope_query_to_active_company(
        Payable.query.filter(Payable.balance_amount > 0),
        Payable.company_id,
    )
    documents = [(rec, "Receivable") for rec in receivables.all()]
    documents += [(pay, "Payable") for pay in payables.all()]
    actions = []
    for document, _label in sorted(documents, key=lambda pair: pair[0].due_date or date.max):
        if not document.due_date:
            continue
        days = (document.due_date - today).days
        if days > 7:
            continue
        if isinstance(document, Receivable):
            source_type = "OPENING_RECEIVABLE" if (document.is_opening or document.source_type == "OPENING_RECEIVABLE") else document.source_type
        else:
            source_type = "OPENING_PAYABLE" if document.is_opening else document.source_type
        is_opening = document.is_opening or document.source_type in {"OPENING_RECEIVABLE", "OPENING_PAYABLE"}
        actions.append(source_document_actions(source_type, document.id if is_opening else document.source_id))
    return actions


def opening_summary_actions():
    actions = []
    layers = scope_query_to_active_company(
        FIFOLayer.query.filter_by(source_type="OPENING_STOCK"),
        FIFOLayer.company_id,
    )
    actions.extend(
        source_document_actions("OPENING_STOCK", layer.source_id)
        for layer in layers.order_by(FIFOLayer.source_date.desc()).all()
    )
    receivables = scope_query_to_active_company(
        Receivable.query.filter(db.or_(Receivable.is_opening.is_(True), Receivable.source_type == "OPENING_RECEIVABLE")),
        Receivable.company_id,
    )
    actions.extend(
        source_document_actions("OPENING_RECEIVABLE", record.id)
        for record in receivables.all()
    )
    payables = scope_query_to_active_company(Payable.query.filter_by(is_opening=True), Payable.company_id)
    actions.extend(
        source_document_actions("OPENING_PAYABLE", record.id)
        for record in payables.all()
    )
    payments = scope_query_to_active_company(
        Payment.query.filter(Payment.payment_type.like("OPENING_ADVANCE%")),
        Payment.company_id,
    )
    actions.extend(payment_actions(payment) for payment in payments.all())
    return actions


def stock_item_history_actions(rows, company_index, stock_book_index, item_index, item_mode):
    companies = {company.code: company for company in Company.query.all()}
    items_by_code = {item.code: item for item in Item.query.all()}
    items_by_display = {item.display_name: item for item in Item.query.all()}
    books = {
        (book.company_id, book.name): book
        for book in StockBook.query.all()
    }
    actions = []
    for row in rows:
        try:
            company = companies.get(str(row[company_index]))
            item_lookup = items_by_code if item_mode == "code" else items_by_display
            item = item_lookup.get(str(row[item_index]))
            stock_book = books.get((company.id, str(row[stock_book_index]))) if company else None
        except IndexError:
            actions.append([])
            continue
        if company and item:
            args = {
                "company_id": company.id,
                "item_id": item.id,
            }
            if stock_book:
                args["stock_book_id"] = stock_book.id
            actions.append([
                {
                    "label": "History",
                    "url": url_for("reports.item_ledger", **args),
                    "title": f"Open movement history for {item.display_name}",
                }
            ])
        else:
            actions.append([])
    return actions


def build_report(name):
    builders = {
        "current-stock": current_stock_rows,
        "fifo-valuation": fifo_valuation_rows,
        "fifo-layers": fifo_layer_rows,
        "stock-ledger": stock_ledger_rows,
        "purchases": purchase_rows,
        "purchases-monthly": purchase_monthly_rows,
        "sales": sales_rows,
        "sales-monthly": sales_monthly_rows,
        "sales-by-type": sales_by_type_rows,
        "gross-profit": gross_profit_rows,
        "customer-outstanding": customer_outstanding_rows,
        "supplier-outstanding": supplier_outstanding_rows,
        "advances": advances_rows,
        "payment-history": payment_history_rows,
        "due-alerts": due_alert_rows,
        "stock-alerts": stock_alert_rows,
        "inter-company": inter_company_rows,
        "opening-summary": opening_summary_rows,
        "purchase-price-fluctuation": purchase_price_rows,
        "sale-price-fluctuation": sale_price_rows,
        "audit": audit_rows,
    }
    return builders[name]()


def current_stock_rows():
    headers = ["Company", "Stock book", "Item code", "Item", "Unit", "Quantity", "FIFO value", "Minimum stock", "Status"]
    rows = []
    books = scope_query_to_active_company(StockBook.query, StockBook.company_id).order_by(StockBook.code).all()
    items = Item.query.order_by(Item.code).all()
    for book in books:
        for item in items:
            quantity = available_quantity(book.company_id, book.id, item.id)
            value = available_value(book.company_id, book.id, item.id)
            if quantity < Decimal("0.000"):
                status = "NEGATIVE"
            elif quantity == Decimal("0.000"):
                status = "OUT"
            elif quantity <= item.minimum_stock:
                status = "LOW"
            else:
                status = "NORMAL"
            rows.append([book.company.code, book.name, item.code, item.name, item.unit, fmt_qty(quantity), fmt_money(value), fmt_qty(item.minimum_stock), status])
    return headers, rows


def fifo_valuation_rows():
    headers, rows = current_stock_rows()
    return headers, rows


def fifo_layer_rows():
    headers = ["Company", "Stock book", "Item", "Layer date", "Source", "Reference", "Original qty", "Available qty", "Rate", "Available value", "Status", "Created by"]
    rows = []
    query = scope_query_to_active_company(FIFOLayer.query, FIFOLayer.company_id)
    for layer in query.order_by(FIFOLayer.source_date, FIFOLayer.id).all():
        rows.append([
            layer.company.code,
            layer.stock_book.name,
            layer.item.display_name,
            layer.source_date,
            layer.source_type,
            layer.source_reference,
            fmt_qty(layer.original_quantity),
            fmt_qty(layer.available_quantity),
            layer.unit_cost,
            fmt_money(layer.available_value),
            layer.status,
            creator_name(layer.created_by_id),
        ])
    return headers, rows


def stock_ledger_rows():
    headers = ["Date", "Company", "Stock book", "Item", "Type", "Reference", "In", "Out", "Rate", "Value", "Remarks", "Created by"]
    rows = []
    query = scope_query_to_active_company(StockLedgerEntry.query, StockLedgerEntry.company_id)
    for entry in query.order_by(StockLedgerEntry.entry_date, StockLedgerEntry.id).all():
        rows.append([
            entry.entry_date,
            entry.company.code,
            entry.stock_book.name,
            entry.item.display_name,
            entry.transaction_type,
            entry.reference_number,
            fmt_qty(entry.quantity_in),
            fmt_qty(entry.quantity_out),
            entry.rate,
            fmt_money(entry.value),
            entry.remarks or "",
            creator_name(entry.created_by_id),
        ])
    return headers, rows


def purchase_report_query():
    query = scope_query_to_active_company(Purchase.query.filter_by(is_void=False), Purchase.company_id)
    selected_company_id = selected_report_company_id()
    if selected_company_id:
        query = query.filter(Purchase.company_id == selected_company_id)
    start, end = month_bounds()
    if start:
        query = query.filter(Purchase.bill_date >= start, Purchase.bill_date < end)
    return query


def sale_report_query():
    query = scope_query_to_active_company(Sale.query.filter_by(is_void=False), Sale.company_id)
    selected_company_id = selected_report_company_id()
    if selected_company_id:
        query = query.filter(Sale.company_id == selected_company_id)
    sale_type = (request.args.get("sale_type") or "").strip()
    if sale_type:
        query = query.filter(Sale.sale_type == sale_type)
    start, end = month_bounds()
    if start:
        query = query.filter(Sale.invoice_date >= start, Sale.invoice_date < end)
    return query


def sale_report_lines_query():
    query = scope_query_to_active_company(
        SaleLine.query.join(Sale).filter(Sale.is_void.is_(False)),
        Sale.company_id,
    )
    selected_company_id = selected_report_company_id()
    if selected_company_id:
        query = query.filter(Sale.company_id == selected_company_id)
    sale_type = (request.args.get("sale_type") or "").strip()
    if sale_type:
        query = query.filter(Sale.sale_type == sale_type)
    start, end = month_bounds()
    if start:
        query = query.filter(Sale.invoice_date >= start, Sale.invoice_date < end)
    return query


def purchase_rows():
    headers = ["Date", "Company", "Book", "Supplier", "Bill", "Type", "Subtotal", "GST", "Grand total", "Paid", "Balance", "Status", "Created by"]
    rows = []
    for purchase in purchase_report_query().order_by(Purchase.bill_date.desc(), Purchase.id.desc()).all():
        rows.append([
            purchase.bill_date,
            purchase.company.code,
            purchase.stock_book.name,
            purchase.supplier.name,
            purchase.bill_number,
            purchase.purchase_type,
            fmt_money(purchase.subtotal),
            fmt_money(purchase.gst_total),
            fmt_money(purchase.grand_total),
            fmt_money(purchase.paid_amount),
            fmt_money(purchase.balance_amount),
            purchase.payment_status,
            creator_name(purchase.created_by_id),
        ])
    return headers, rows


def purchase_monthly_rows():
    headers = ["Month", "Company", "Bills", "Subtotal", "GST", "Grand total", "Paid", "Balance"]
    groups = {}
    query = scope_query_to_active_company(Purchase.query.filter_by(is_void=False), Purchase.company_id)
    for purchase in query.all():
        key = (purchase.bill_date.strftime("%Y-%m"), purchase.company.code)
        group = groups.setdefault(
            key,
            {
                "month": key[0],
                "company": key[1],
                "bills": 0,
                "subtotal": Decimal("0.00"),
                "gst": Decimal("0.00"),
                "grand": Decimal("0.00"),
                "paid": Decimal("0.00"),
                "balance": Decimal("0.00"),
            },
        )
        group["bills"] += 1
        group["subtotal"] = money(group["subtotal"] + purchase.subtotal)
        group["gst"] = money(group["gst"] + purchase.gst_total)
        group["grand"] = money(group["grand"] + purchase.grand_total)
        group["paid"] = money(group["paid"] + purchase.paid_amount)
        group["balance"] = money(group["balance"] + purchase.balance_amount)
    rows = []
    for group in sorted(
        groups.values(), key=lambda item: (item["month"], item["company"]), reverse=True
    ):
        rows.append([
            group["month"],
            group["company"],
            group["bills"],
            fmt_money(group["subtotal"]),
            fmt_money(group["gst"]),
            fmt_money(group["grand"]),
            fmt_money(group["paid"]),
            fmt_money(group["balance"]),
        ])
    return headers, rows


def sales_rows():
    headers = [
        "Date",
        "Company",
        "Book",
        "Customer",
        "Invoice",
        "Type",
        "Product",
        "Quantity",
        "Rate (ex GST)",
        "GST %",
        "Line subtotal",
        "GST amount",
        "Line total",
        "FIFO cost",
        "Gross profit",
        "Grand total",
        "Paid",
        "Balance",
        "Status",
        "Created by",
    ]
    rows = []
    emitted_totals = set()
    lines = sale_report_lines_query().order_by(
        Sale.invoice_date.desc(), Sale.id.desc(), SaleLine.id.asc()
    ).all()
    for line in lines:
        sale = line.sale
        show_invoice_totals = sale.id not in emitted_totals
        emitted_totals.add(sale.id)
        rows.append([
            sale.invoice_date,
            sale.company.code,
            sale.stock_book.name,
            sale.customer.name,
            sale.invoice_number,
            sale.sale_type,
            line.item.display_name,
            fmt_qty(line.quantity),
            fmt_money(line.sale_rate),
            f"{fmt_qty(line.gst_percent)}%",
            fmt_money(line.subtotal),
            fmt_money(line.gst_amount),
            fmt_money(line.line_total),
            fmt_money(line.fifo_cost),
            fmt_money(line.gross_profit),
            fmt_money(sale.grand_total) if show_invoice_totals else "",
            fmt_money(sale.paid_amount) if show_invoice_totals else "",
            fmt_money(sale.balance_amount) if show_invoice_totals else "",
            sale.payment_status if show_invoice_totals else "",
            creator_name(sale.created_by_id) if show_invoice_totals else "",
        ])
    return headers, rows


def sales_monthly_rows():
    headers = [
        "Month",
        "Company",
        "Invoices",
        "Subtotal",
        "GST",
        "Grand total",
        "FIFO cost",
        "Gross profit",
        "Balance",
    ]
    groups = {}
    query = scope_query_to_active_company(Sale.query.filter_by(is_void=False), Sale.company_id)
    for sale in query.all():
        key = (sale.invoice_date.strftime("%Y-%m"), sale.company.code)
        group = groups.setdefault(
            key,
            {
                "month": key[0],
                "company": key[1],
                "invoices": 0,
                "subtotal": Decimal("0.00"),
                "gst": Decimal("0.00"),
                "grand": Decimal("0.00"),
                "fifo": Decimal("0.00"),
                "profit": Decimal("0.00"),
                "balance": Decimal("0.00"),
            },
        )
        group["invoices"] += 1
        group["subtotal"] = money(group["subtotal"] + sale.subtotal)
        group["gst"] = money(group["gst"] + sale.gst_total)
        group["grand"] = money(group["grand"] + sale.grand_total)
        group["fifo"] = money(group["fifo"] + sale.fifo_cost)
        group["profit"] = money(group["profit"] + sale.gross_profit)
        group["balance"] = money(group["balance"] + sale.balance_amount)
    rows = []
    for group in sorted(
        groups.values(), key=lambda item: (item["month"], item["company"]), reverse=True
    ):
        rows.append([
            group["month"],
            group["company"],
            group["invoices"],
            fmt_money(group["subtotal"]),
            fmt_money(group["gst"]),
            fmt_money(group["grand"]),
            fmt_money(group["fifo"]),
            fmt_money(group["profit"]),
            fmt_money(group["balance"]),
        ])
    return headers, rows


def sales_by_type_rows():
    headers = ["Company", "Type", "Invoices", "Subtotal", "GST", "Grand total", "Gross profit"]
    rows = []
    query = (
        db.session.query(
            Company.code,
            StockBook.book_type,
            db.func.count(Sale.id),
            db.func.coalesce(db.func.sum(Sale.subtotal), 0),
            db.func.coalesce(db.func.sum(Sale.gst_total), 0),
            db.func.coalesce(db.func.sum(Sale.grand_total), 0),
            db.func.coalesce(db.func.sum(Sale.gross_profit), 0),
        )
        .join(Company, Sale.company_id == Company.id)
        .join(StockBook, Sale.stock_book_id == StockBook.id)
        .filter(Sale.is_void.is_(False))
    )
    query = scope_query_to_active_company(query, Sale.company_id).group_by(Company.code, StockBook.book_type)
    for row in query:
        rows.append([row[0], row[1], row[2], fmt_money(row[3]), fmt_money(row[4]), fmt_money(row[5]), fmt_money(row[6])])
    return headers, rows


def gross_profit_rows():
    headers = ["Invoice", "Date", "Company", "Customer", "Item", "Sale value ex GST", "FIFO cost", "Gross profit", "Margin %"]
    rows = []
    query = scope_query_to_active_company(
        SaleLine.query.join(Sale).filter(Sale.is_void.is_(False)),
        Sale.company_id,
    )
    for line in query.order_by(Sale.invoice_date.desc()).all():
        margin = Decimal("0.00")
        if line.subtotal:
            margin = money((line.gross_profit / line.subtotal) * Decimal("100"))
        rows.append([line.sale.invoice_number, line.sale.invoice_date, line.sale.company.code, line.sale.customer.name, line.item.display_name, fmt_money(line.subtotal), fmt_money(line.fifo_cost), fmt_money(line.gross_profit), f"{margin}%"])
    return headers, rows


def created_by_summary(user_ids):
    names = {creator_name(user_id) for user_id in user_ids}
    if len(names) == 1:
        return names.pop()
    return "Multiple users"


def format_grouped_outstanding_rows(
    entries,
    party_kind,
    include_documents=True,
    include_dates=True,
    include_status=True,
):
    rows = []
    for group in grouped_party_outstanding(entries, party_kind):
        advance_credit = money(group.get("advance_offset", Decimal("0.00")) + group.get("open_advance", Decimal("0.00")))
        row = [
            group["company"],
            group["party"],
            fmt_money(group["total"]),
            fmt_money(group["paid"]),
            fmt_money(advance_credit),
            fmt_money(group["balance"]),
            created_by_summary(group["created_by_ids"]),
        ]
        if include_documents:
            row.insert(2, group["documents_label"])
        if include_dates:
            insert_at = 3 if include_documents else 2
            row[insert_at:insert_at] = [group["date"], group["due_date"] or ""]
        if include_status:
            row.insert(len(row) - 1, group["status"])
        rows.append(row)
    return rows


def customer_outstanding_rows():
    headers = ["Company", "Customer", "Debit bills", "Credit received", "Advance credit", "Closing balance", "Created by"]
    query = scope_query_to_active_company(
        Receivable.query.filter(Receivable.balance_amount > 0),
        Receivable.company_id,
    )
    entries = query.order_by(Receivable.due_date, Receivable.document_number).all()
    return headers, format_grouped_outstanding_rows(
        entries,
        "customer",
        include_documents=False,
        include_dates=False,
        include_status=False,
    )


def supplier_outstanding_rows():
    headers = ["Company", "Supplier", "Documents", "First date", "Next due", "Debit bills", "Credit paid", "Advance", "Closing balance", "Status", "Created by"]
    query = scope_query_to_active_company(
        Payable.query.filter(Payable.balance_amount > 0),
        Payable.company_id,
    )
    entries = query.order_by(Payable.due_date, Payable.document_number).all()
    return headers, format_grouped_outstanding_rows(entries, "supplier")


def advances_rows():
    headers = ["Date", "Company", "Type", "Party", "Mode", "Original", "Allocated", "Unallocated", "Reference", "Created by"]
    rows = []
    query = scope_query_to_active_company(Payment.query.filter(Payment.unallocated_amount > 0), Payment.company_id)
    for payment in query.order_by(Payment.payment_date.desc()).all():
        party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else ""
        rows.append([payment.payment_date, payment.company.code, payment.payment_type, party, payment.mode, fmt_money(payment.total_amount), fmt_money(payment.allocated_amount), fmt_money(payment.unallocated_amount), payment.reference_number or "", creator_name(payment.created_by_id)])
    return headers, rows


def payment_history_rows():
    headers = ["Date", "Company", "Type", "Party", "Mode", "Amount", "Allocated", "Unallocated", "Reference", "Created by"]
    rows = []
    query = scope_query_to_active_company(Payment.query, Payment.company_id)
    for payment in query.order_by(Payment.payment_date.desc(), Payment.id.desc()).all():
        party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else ""
        rows.append([payment.payment_date, payment.company.code, payment.payment_type, party, payment.mode, fmt_money(payment.total_amount), fmt_money(payment.allocated_amount), fmt_money(payment.unallocated_amount), payment.reference_number or "", creator_name(payment.created_by_id)])
    return headers, rows


def due_alert_rows():
    headers = ["Severity", "Type", "Company", "Party", "Document", "Due date", "Balance", "Message"]
    rows = []
    today = date.today()
    receivables = scope_query_to_active_company(
        Receivable.query.filter(Receivable.balance_amount > 0),
        Receivable.company_id,
    )
    payables = scope_query_to_active_company(
        Payable.query.filter(Payable.balance_amount > 0),
        Payable.company_id,
    )
    documents = [(rec, "Customer receivable") for rec in receivables.all()]
    documents += [(pay, "Supplier payable") for pay in payables.all()]
    for doc, label in sorted(documents, key=lambda pair: pair[0].due_date or date.max):
        if not doc.due_date:
            continue
        if doc.due_date < today:
            severity = "OVERDUE"
            detail = f"{(today - doc.due_date).days} days overdue"
        elif doc.due_date == today:
            severity = "DUE TODAY"
            detail = "due today"
        elif (doc.due_date - today).days <= 7:
            severity = "UPCOMING"
            detail = f"due in {(doc.due_date - today).days} days"
        else:
            continue
        party = getattr(doc, "customer", None) or getattr(doc, "supplier", None) or getattr(doc, "counterparty_company", None)
        rows.append([severity, label, doc.company.code, party.name if party else "", doc.document_number, doc.due_date, fmt_money(doc.balance_amount), f"{doc.document_number} is {detail}."])
    return headers, rows


def stock_alert_rows():
    headers = ["Severity", "Company", "Stock book", "Item", "Quantity", "Minimum", "Message"]
    rows = []
    books = scope_query_to_active_company(StockBook.query.filter_by(active=True), StockBook.company_id).order_by(StockBook.code).all()
    items = Item.query.filter_by(active=True).order_by(Item.code).all()
    for book in books:
        for item in items:
            quantity = available_quantity(book.company_id, book.id, item.id)
            if quantity < Decimal("0.000"):
                rows.append(["NEGATIVE", book.company.code, book.name, item.display_name, fmt_qty(quantity), fmt_qty(item.minimum_stock), f"{item.name} is negative in {book.name}."])
            elif quantity == Decimal("0.000"):
                rows.append(["OUT", book.company.code, book.name, item.display_name, fmt_qty(quantity), fmt_qty(item.minimum_stock), f"{item.name} is out of stock in {book.name}."])
            elif quantity <= item.minimum_stock:
                rows.append(["LOW", book.company.code, book.name, item.display_name, fmt_qty(quantity), fmt_qty(item.minimum_stock), f"{item.name} is low in {book.name}."])
    return headers, rows


def inter_company_rows():
    headers = ["Owner", "User", "Item", "Opening Pending", "Issued This Month", "Returned This Month", "Pending Balance"]
    rows = []
    for entry in pending_transfer_summary():
        if not in_active_company_scope(entry["owner"].id, entry["user"].id):
            continue
        rows.append([
            entry["owner"].code,
            entry["user"].code,
            entry["item"].display_name,
            fmt_qty(entry["opening"]),
            fmt_qty(entry["issued"]),
            fmt_qty(entry["returned"]),
            fmt_qty(entry["pending"]),
        ])
    return headers, rows


def opening_summary_rows():
    headers = ["Type", "Company", "Party/Book", "Document", "Date", "Amount/Value", "Paid/Allocated", "Balance/Qty", "Status", "Created by"]
    rows = []
    layers = scope_query_to_active_company(FIFOLayer.query.filter_by(source_type="OPENING_STOCK"), FIFOLayer.company_id)
    for layer in layers.order_by(FIFOLayer.source_date.desc()).all():
        rows.append(["Opening stock", layer.company.code, layer.stock_book.name, layer.source_reference, layer.source_date, fmt_money(layer.original_value), "", fmt_qty(layer.original_quantity), "", creator_name(layer.created_by_id)])
    receivables = scope_query_to_active_company(
        Receivable.query.filter(db.or_(Receivable.is_opening.is_(True), Receivable.source_type == "OPENING_RECEIVABLE")),
        Receivable.company_id,
    )
    for rec in receivables.all():
        rows.append(["Opening receivable", rec.company.code, rec.customer.name if rec.customer else "", rec.document_number, rec.document_date, fmt_money(rec.total_amount), fmt_money(rec.paid_amount), fmt_money(rec.balance_amount), rec.payment_status, creator_name(rec.created_by_id)])
    payables = scope_query_to_active_company(Payable.query.filter_by(is_opening=True), Payable.company_id)
    for pay in payables.all():
        rows.append(["Opening payable", pay.company.code, pay.supplier.name if pay.supplier else "", pay.document_number, pay.document_date, fmt_money(pay.total_amount), fmt_money(pay.paid_amount), fmt_money(pay.balance_amount), pay.payment_status, creator_name(pay.created_by_id)])
    payments = scope_query_to_active_company(Payment.query.filter(Payment.payment_type.like("OPENING_ADVANCE%")), Payment.company_id)
    for payment in payments.all():
        party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else ""
        status = "UNALLOCATED" if payment.unallocated_amount > 0 else "ALLOCATED"
        rows.append([payment.payment_type, payment.company.code, party, payment.reference_number or "", payment.payment_date, fmt_money(payment.total_amount), fmt_money(payment.allocated_amount), fmt_money(payment.unallocated_amount), status, creator_name(payment.created_by_id)])
    return headers, rows


def purchase_price_rows():
    headers = ["Item", "Supplier", "Previous rate", "Latest rate", "Change", "Change %", "Previous date", "Latest date"]
    rows = []
    grouped = {}
    query = scope_query_to_active_company(
        PurchaseLine.query.join(Purchase).filter(Purchase.is_void.is_(False)),
        Purchase.company_id,
    )
    for line in query.order_by(Purchase.bill_date.desc(), PurchaseLine.id.desc()).all():
        key = (line.item_id, line.purchase.supplier_id)
        grouped.setdefault(key, []).append(line)
    for entries in grouped.values():
        if len(entries) < 2:
            continue
        latest, previous = entries[0], entries[1]
        change = money(latest.rate - previous.rate)
        pct = Decimal("0.00") if previous.rate == 0 else money((change / previous.rate) * Decimal("100"))
        rows.append([latest.item.display_name, latest.purchase.supplier.name, previous.rate, latest.rate, fmt_money(change), f"{pct}%", previous.purchase.bill_date, latest.purchase.bill_date])
    return headers, rows


def sale_price_rows():
    headers = ["Item", "Customer", "Previous rate", "Latest rate", "Change", "Change %", "Previous date", "Latest date"]
    rows = []
    grouped = {}
    query = scope_query_to_active_company(SaleLine.query.join(Sale), Sale.company_id)
    for line in query.order_by(Sale.invoice_date.desc(), SaleLine.id.desc()).all():
        key = (line.item_id, line.sale.customer_id)
        grouped.setdefault(key, []).append(line)
    for entries in grouped.values():
        if len(entries) < 2:
            continue
        latest, previous = entries[0], entries[1]
        change = money(latest.sale_rate - previous.sale_rate)
        pct = Decimal("0.00") if previous.sale_rate == 0 else money((change / previous.sale_rate) * Decimal("100"))
        rows.append([latest.item.display_name, latest.sale.customer.name, previous.sale_rate, latest.sale_rate, fmt_money(change), f"{pct}%", previous.sale.invoice_date, latest.sale.invoice_date])
    return headers, rows


def audit_rows():
    headers = ["Time", "User", "Action", "Entity", "Reference", "Approval reason", "IP"]
    rows = []
    for log in AuditLog.query.order_by(AuditLog.created_at.desc()).limit(500).all():
        rows.append([log.created_at, log.user.email if log.user else "", log.action, log.entity_type, log.reference or log.entity_id or "", log.approval_reason or "", log.ip_address or ""])
    return headers, rows
