from datetime import date
from decimal import Decimal

from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import login_required

from app.core.company_context import active_company
from app.core.formatting import fmt_money, fmt_qty, money
from app.core.security import require_permission
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
from app.services.outstanding import grouped_party_outstanding
from app.services.stock import available_quantity, available_value
from app.services.transactions import pending_transfer_summary

bp = Blueprint("reports", __name__, url_prefix="/reports")


REPORT_TITLES = {
    "current-stock": "Current Stock Report",
    "fifo-valuation": "FIFO Valuation Report",
    "fifo-layers": "FIFO Layer Detail",
    "stock-ledger": "Stock Ledger",
    "purchases": "Purchase Report",
    "sales": "Sales Report",
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
        reports=REPORT_TITLES,
        totals=report_totals(headers, rows),
    )


def build_report(name):
    builders = {
        "current-stock": current_stock_rows,
        "fifo-valuation": fifo_valuation_rows,
        "fifo-layers": fifo_layer_rows,
        "stock-ledger": stock_ledger_rows,
        "purchases": purchase_rows,
        "sales": sales_rows,
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


def purchase_rows():
    headers = ["Date", "Company", "Book", "Supplier", "Bill", "Type", "Subtotal", "GST", "Grand total", "Paid", "Balance", "Status", "Created by"]
    rows = []
    query = scope_query_to_active_company(Purchase.query.filter_by(is_void=False), Purchase.company_id)
    for purchase in query.order_by(Purchase.bill_date.desc(), Purchase.id.desc()).all():
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


def sales_rows():
    headers = ["Date", "Company", "Book", "Customer", "Invoice", "Type", "Subtotal", "GST", "Grand total", "FIFO cost", "Gross profit", "Balance", "Status", "Created by"]
    rows = []
    query = scope_query_to_active_company(Sale.query.filter_by(is_void=False), Sale.company_id)
    for sale in query.order_by(Sale.invoice_date.desc(), Sale.id.desc()).all():
        rows.append([
            sale.invoice_date,
            sale.company.code,
            sale.stock_book.name,
            sale.customer.name,
            sale.invoice_number,
            sale.sale_type,
            fmt_money(sale.subtotal),
            fmt_money(sale.gst_total),
            fmt_money(sale.grand_total),
            fmt_money(sale.fifo_cost),
            fmt_money(sale.gross_profit),
            fmt_money(sale.balance_amount),
            sale.payment_status,
            creator_name(sale.created_by_id),
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


def format_grouped_outstanding_rows(entries, party_kind):
    rows = []
    for group in grouped_party_outstanding(entries, party_kind):
        rows.append([
            group["company"],
            group["party"],
            group["documents_label"],
            group["date"],
            group["due_date"] or "",
            fmt_money(group["total"]),
            fmt_money(group["paid"]),
            fmt_money(group["balance"]),
            group["status"],
            created_by_summary(group["created_by_ids"]),
        ])
    return rows


def customer_outstanding_rows():
    headers = ["Company", "Customer", "Documents", "First date", "Next due", "Total", "Paid", "Balance", "Status", "Created by"]
    query = scope_query_to_active_company(Receivable.query, Receivable.company_id)
    entries = query.order_by(Receivable.due_date, Receivable.document_number).all()
    return headers, format_grouped_outstanding_rows(entries, "customer")


def supplier_outstanding_rows():
    headers = ["Company", "Supplier", "Documents", "First date", "Next due", "Total", "Paid", "Balance", "Status", "Created by"]
    query = scope_query_to_active_company(Payable.query, Payable.company_id)
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
    headers = ["Type", "Company", "Party/Book", "Document", "Date", "Amount/Value", "Balance/Qty", "Created by"]
    rows = []
    layers = scope_query_to_active_company(FIFOLayer.query.filter_by(source_type="OPENING_STOCK"), FIFOLayer.company_id)
    for layer in layers.order_by(FIFOLayer.source_date.desc()).all():
        rows.append(["Opening stock", layer.company.code, layer.stock_book.name, layer.source_reference, layer.source_date, fmt_money(layer.original_value), fmt_qty(layer.original_quantity), creator_name(layer.created_by_id)])
    receivables = scope_query_to_active_company(Receivable.query.filter_by(is_opening=True), Receivable.company_id)
    for rec in receivables.all():
        rows.append(["Opening receivable", rec.company.code, rec.customer.name if rec.customer else "", rec.document_number, rec.document_date, fmt_money(rec.total_amount), fmt_money(rec.balance_amount), creator_name(rec.created_by_id)])
    payables = scope_query_to_active_company(Payable.query.filter_by(is_opening=True), Payable.company_id)
    for pay in payables.all():
        rows.append(["Opening payable", pay.company.code, pay.supplier.name if pay.supplier else "", pay.document_number, pay.document_date, fmt_money(pay.total_amount), fmt_money(pay.balance_amount), creator_name(pay.created_by_id)])
    payments = scope_query_to_active_company(Payment.query.filter(Payment.payment_type.like("OPENING_ADVANCE%")), Payment.company_id)
    for payment in payments.all():
        party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else ""
        rows.append([payment.payment_type, payment.company.code, party, payment.reference_number or "", payment.payment_date, fmt_money(payment.total_amount), fmt_money(payment.unallocated_amount), creator_name(payment.created_by_id)])
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
