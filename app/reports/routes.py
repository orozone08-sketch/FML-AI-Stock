from datetime import date
from decimal import Decimal

from flask import Blueprint, flash, redirect, render_template, request, url_for
from flask_login import login_required

from app.core.formatting import fmt_money, fmt_qty, money, qty
from app.core.security import require_permission
from app.exports.reporting import export_table
from app.extensions import db
from app.models import (
    AuditLog,
    Company,
    FIFOLayer,
    InterCompanyLedgerEntry,
    InterCompanyTransfer,
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
)

bp = Blueprint("reports", __name__, url_prefix="/reports")


REPORT_TITLES = {
    "current-stock": "Current Stock Report",
    "fifo-valuation": "FIFO Valuation Report",
    "fifo-layers": "FIFO Layer Detail",
    "stock-ledger": "Stock Ledger",
    "purchases": "Purchase Report",
    "sales": "Sales Report",
    "sales-by-type": "Sales by Company and Type",
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


@bp.route("/")
@login_required
@require_permission("reports", "view")
def index():
    return render_template("reports/index.html", reports=REPORT_TITLES)


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
    return render_template("reports/table.html", title=title, headers=headers, rows=rows, reports=REPORT_TITLES)


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
    books = StockBook.query.order_by(StockBook.code).all()
    items = Item.query.order_by(Item.code).all()
    for book in books:
        for item in items:
            quantity_value = (
                db.session.query(
                    db.func.coalesce(db.func.sum(FIFOLayer.available_quantity), 0),
                    db.func.coalesce(db.func.sum(FIFOLayer.available_value), 0),
                )
                .filter(
                    FIFOLayer.stock_book_id == book.id,
                    FIFOLayer.item_id == item.id,
                    FIFOLayer.available_quantity > 0,
                )
                .first()
            )
            quantity, value = quantity_value
            quantity = qty(quantity or 0)
            if quantity == Decimal("0.000"):
                status = "OUT"
            elif quantity <= item.minimum_stock:
                status = "LOW"
            else:
                status = "NORMAL"
            rows.append([book.company.code, book.name, item.code, item.name, item.unit, fmt_qty(quantity), fmt_money(value or 0), fmt_qty(item.minimum_stock), status])
    return headers, rows


def fifo_valuation_rows():
    headers, rows = current_stock_rows()
    return headers, rows


def fifo_layer_rows():
    headers = ["Company", "Stock book", "Item", "Layer date", "Source", "Reference", "Original qty", "Available qty", "Rate", "Available value", "Status"]
    rows = []
    for layer in FIFOLayer.query.order_by(FIFOLayer.source_date, FIFOLayer.id).all():
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
        ])
    return headers, rows


def stock_ledger_rows():
    headers = ["Date", "Company", "Stock book", "Item", "Type", "Reference", "In", "Out", "Rate", "Value", "Remarks"]
    rows = []
    for entry in StockLedgerEntry.query.order_by(StockLedgerEntry.entry_date, StockLedgerEntry.id).all():
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
        ])
    return headers, rows


def purchase_rows():
    headers = ["Date", "Company", "Book", "Supplier", "Bill", "Type", "Subtotal", "GST", "Grand total", "Paid", "Balance", "Status"]
    rows = []
    for purchase in Purchase.query.order_by(Purchase.bill_date.desc(), Purchase.id.desc()).all():
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
        ])
    return headers, rows


def sales_rows():
    headers = ["Date", "Company", "Book", "Customer", "Invoice", "Type", "Subtotal", "GST", "Grand total", "FIFO cost", "Gross profit", "Balance", "Status"]
    rows = []
    for sale in Sale.query.order_by(Sale.invoice_date.desc(), Sale.id.desc()).all():
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
        .group_by(Company.code, StockBook.book_type)
    )
    for row in query:
        rows.append([row[0], row[1], row[2], fmt_money(row[3]), fmt_money(row[4]), fmt_money(row[5]), fmt_money(row[6])])
    return headers, rows


def gross_profit_rows():
    headers = ["Invoice", "Date", "Company", "Customer", "Item", "Sale value ex GST", "FIFO cost", "Gross profit", "Margin %"]
    rows = []
    for line in SaleLine.query.join(Sale).order_by(Sale.invoice_date.desc()).all():
        margin = Decimal("0.00")
        if line.subtotal:
            margin = money((line.gross_profit / line.subtotal) * Decimal("100"))
        rows.append([line.sale.invoice_number, line.sale.invoice_date, line.sale.company.code, line.sale.customer.name, line.item.display_name, fmt_money(line.subtotal), fmt_money(line.fifo_cost), fmt_money(line.gross_profit), f"{margin}%"])
    return headers, rows


def customer_outstanding_rows():
    headers = ["Company", "Customer", "Document", "Date", "Due date", "Total", "Paid", "Balance", "Status"]
    rows = []
    for rec in Receivable.query.order_by(Receivable.due_date, Receivable.document_number).all():
        party = rec.customer.name if rec.customer else rec.counterparty_company.name
        rows.append([rec.company.code, party, rec.document_number, rec.document_date, rec.due_date or "", fmt_money(rec.total_amount), fmt_money(rec.paid_amount), fmt_money(rec.balance_amount), rec.payment_status])
    return headers, rows


def supplier_outstanding_rows():
    headers = ["Company", "Supplier", "Document", "Date", "Due date", "Total", "Paid", "Balance", "Status"]
    rows = []
    for pay in Payable.query.order_by(Payable.due_date, Payable.document_number).all():
        party = pay.supplier.name if pay.supplier else pay.counterparty_company.name
        rows.append([pay.company.code, party, pay.document_number, pay.document_date, pay.due_date or "", fmt_money(pay.total_amount), fmt_money(pay.paid_amount), fmt_money(pay.balance_amount), pay.payment_status])
    return headers, rows


def advances_rows():
    headers = ["Date", "Company", "Type", "Party", "Mode", "Original", "Allocated", "Unallocated", "Reference"]
    rows = []
    for payment in Payment.query.filter(Payment.unallocated_amount > 0).order_by(Payment.payment_date.desc()).all():
        party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else ""
        rows.append([payment.payment_date, payment.company.code, payment.payment_type, party, payment.mode, fmt_money(payment.total_amount), fmt_money(payment.allocated_amount), fmt_money(payment.unallocated_amount), payment.reference_number or ""])
    return headers, rows


def payment_history_rows():
    headers = ["Date", "Company", "Type", "Party", "Mode", "Amount", "Allocated", "Unallocated", "Reference"]
    rows = []
    for payment in Payment.query.order_by(Payment.payment_date.desc(), Payment.id.desc()).all():
        party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else ""
        rows.append([payment.payment_date, payment.company.code, payment.payment_type, party, payment.mode, fmt_money(payment.total_amount), fmt_money(payment.allocated_amount), fmt_money(payment.unallocated_amount), payment.reference_number or ""])
    return headers, rows


def due_alert_rows():
    headers = ["Severity", "Type", "Company", "Party", "Document", "Due date", "Balance", "Message"]
    rows = []
    today = date.today()
    documents = [(rec, "Customer receivable") for rec in Receivable.query.filter(Receivable.balance_amount > 0).all()]
    documents += [(pay, "Supplier payable") for pay in Payable.query.filter(Payable.balance_amount > 0).all()]
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
    books = StockBook.query.filter_by(active=True).order_by(StockBook.code).all()
    items = Item.query.filter_by(active=True).order_by(Item.code).all()
    for book in books:
        for item in items:
            quantity = (
                db.session.query(db.func.coalesce(db.func.sum(FIFOLayer.available_quantity), 0))
                .filter(FIFOLayer.stock_book_id == book.id, FIFOLayer.item_id == item.id, FIFOLayer.available_quantity > 0)
                .scalar()
            ) or Decimal("0")
            quantity = qty(quantity)
            if quantity == Decimal("0.000"):
                rows.append(["OUT", book.company.code, book.name, item.display_name, fmt_qty(quantity), fmt_qty(item.minimum_stock), f"{item.name} is out of stock in {book.name}."])
            elif quantity <= item.minimum_stock:
                rows.append(["LOW", book.company.code, book.name, item.display_name, fmt_qty(quantity), fmt_qty(item.minimum_stock), f"{item.name} is low in {book.name}."])
    return headers, rows


def inter_company_rows():
    headers = ["Transfer", "Date", "Owner", "User", "Item", "Quantity", "Amount owed", "Settled", "Balance", "Status"]
    rows = []
    for entry in InterCompanyLedgerEntry.query.join(InterCompanyTransfer).order_by(InterCompanyTransfer.transfer_date.desc()).all():
        rows.append([entry.transfer.reference_number, entry.transfer.transfer_date, entry.owner_company.code, entry.user_company.code, entry.item.display_name if entry.item else "", fmt_qty(entry.quantity), fmt_money(entry.amount_owed), fmt_money(entry.settled_amount), fmt_money(entry.balance_amount), entry.status])
    return headers, rows


def opening_summary_rows():
    headers = ["Type", "Company", "Party/Book", "Document", "Date", "Amount/Value", "Balance/Qty"]
    rows = []
    for layer in FIFOLayer.query.filter_by(source_type="OPENING_STOCK").order_by(FIFOLayer.source_date.desc()).all():
        rows.append(["Opening stock", layer.company.code, layer.stock_book.name, layer.source_reference, layer.source_date, fmt_money(layer.original_value), fmt_qty(layer.original_quantity)])
    for rec in Receivable.query.filter_by(is_opening=True).all():
        rows.append(["Opening receivable", rec.company.code, rec.customer.name if rec.customer else "", rec.document_number, rec.document_date, fmt_money(rec.total_amount), fmt_money(rec.balance_amount)])
    for pay in Payable.query.filter_by(is_opening=True).all():
        rows.append(["Opening payable", pay.company.code, pay.supplier.name if pay.supplier else "", pay.document_number, pay.document_date, fmt_money(pay.total_amount), fmt_money(pay.balance_amount)])
    for payment in Payment.query.filter(Payment.payment_type.like("OPENING_ADVANCE%")).all():
        party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else ""
        rows.append([payment.payment_type, payment.company.code, party, payment.reference_number or "", payment.payment_date, fmt_money(payment.total_amount), fmt_money(payment.unallocated_amount)])
    return headers, rows


def purchase_price_rows():
    headers = ["Item", "Supplier", "Previous rate", "Latest rate", "Change", "Change %", "Previous date", "Latest date"]
    rows = []
    grouped = {}
    for line in PurchaseLine.query.join(Purchase).order_by(Purchase.bill_date.desc(), PurchaseLine.id.desc()).all():
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
    for line in SaleLine.query.join(Sale).order_by(Sale.invoice_date.desc(), SaleLine.id.desc()).all():
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
