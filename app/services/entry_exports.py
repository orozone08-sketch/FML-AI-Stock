from flask import render_template

from app.core.formatting import fmt_money, fmt_qty
from app.extensions import db
from app.models import User
from app.reports.exporting import export_table


HEADERS = ["Section", "Field", "Value"]


def export_entry(title, rows, fmt):
    fmt = normalize_export_format(fmt)
    return export_table(title, HEADERS, rows, fmt)


def print_entry(title, rows):
    return render_template("print/entry.html", title=title, headers=HEADERS, rows=rows)


def normalize_export_format(fmt):
    fmt = (fmt or "").lower()
    if fmt in {"xlsx", "xl", "excel"}:
        return "xlsx"
    if fmt == "pdf":
        return "pdf"
    raise ValueError("Unsupported export format.")


def creator_name(record):
    user_id = getattr(record, "created_by_id", None)
    if not user_id:
        return "System"
    user = db.session.get(User, int(user_id))
    return user.name if user else "Unknown user"


def row(section, field, value):
    return [section, field, "" if value is None else value]


def purchase_rows(purchase):
    rows = [
        row("Purchase", "Company", purchase.company.name),
        row("Purchase", "Stock book", purchase.stock_book.name),
        row("Purchase", "Supplier", purchase.supplier.name),
        row("Purchase", "Bill number", purchase.bill_number),
        row("Purchase", "Bill date", purchase.bill_date),
        row("Purchase", "Due date", purchase.due_date or ""),
        row("Purchase", "Type", purchase.purchase_type),
        row("Purchase", "Subtotal", fmt_money(purchase.subtotal)),
        row("Purchase", "GST", fmt_money(purchase.gst_total)),
        row("Purchase", "Grand total", fmt_money(purchase.grand_total)),
        row("Purchase", "Paid", fmt_money(purchase.paid_amount)),
        row("Purchase", "Balance", fmt_money(purchase.balance_amount)),
        row("Purchase", "Status", purchase.payment_status),
        row("Purchase", "Created by", creator_name(purchase)),
        row("Purchase", "Remarks", purchase.remarks or ""),
    ]
    for index, line in enumerate(purchase.lines, start=1):
        section = f"Line {index}"
        rows.extend(
            [
                row(section, "Item", line.item.display_name),
                row(section, "Quantity", fmt_qty(line.quantity)),
                row(section, "Rate", line.rate),
                row(section, "GST %", line.gst_percent),
                row(section, "Subtotal", fmt_money(line.subtotal)),
                row(section, "GST amount", fmt_money(line.gst_amount)),
                row(section, "Line total", fmt_money(line.line_total)),
            ]
        )
    return f"Purchase {purchase.bill_number}", rows


def sale_rows(sale):
    rows = [
        row("Sale", "Company", sale.company.name),
        row("Sale", "Stock book", sale.stock_book.name),
        row("Sale", "Customer", sale.customer.name),
        row("Sale", "Invoice number", sale.invoice_number),
        row("Sale", "Invoice date", sale.invoice_date),
        row("Sale", "Due date", sale.due_date or ""),
        row("Sale", "Type", sale.sale_type),
        row("Sale", "Subtotal", fmt_money(sale.subtotal)),
        row("Sale", "GST", fmt_money(sale.gst_total)),
        row("Sale", "Grand total", fmt_money(sale.grand_total)),
        row("Sale", "FIFO cost", fmt_money(sale.fifo_cost)),
        row("Sale", "Gross profit", fmt_money(sale.gross_profit)),
        row("Sale", "Paid", fmt_money(sale.paid_amount)),
        row("Sale", "Balance", fmt_money(sale.balance_amount)),
        row("Sale", "Status", sale.payment_status),
        row("Sale", "Created by", creator_name(sale)),
        row("Sale", "Remarks", sale.remarks or ""),
    ]
    for index, line in enumerate(sale.lines, start=1):
        section = f"Line {index}"
        rows.extend(
            [
                row(section, "Item", line.item.display_name),
                row(section, "Quantity", fmt_qty(line.quantity)),
                row(section, "Rate", line.sale_rate),
                row(section, "GST %", line.gst_percent),
                row(section, "Subtotal", fmt_money(line.subtotal)),
                row(section, "GST amount", fmt_money(line.gst_amount)),
                row(section, "Line total", fmt_money(line.line_total)),
                row(section, "FIFO cost", fmt_money(line.fifo_cost)),
                row(section, "Gross profit", fmt_money(line.gross_profit)),
            ]
        )
    return f"Sale {sale.invoice_number}", rows


def transfer_rows(transfer):
    rows = [
        row("Transfer", "Reference", transfer.reference_number),
        row("Transfer", "Date", transfer.transfer_date),
        row("Transfer", "From company", transfer.from_company.name),
        row("Transfer", "From stock book", transfer.from_stock_book.name),
        row("Transfer", "To company", transfer.to_company.name),
        row("Transfer", "To stock book", transfer.to_stock_book.name),
        row("Transfer", "FIFO value", fmt_money(transfer.total_fifo_value)),
        row("Transfer", "Mismatch approved", "Yes" if transfer.mismatch_approved else "No"),
        row("Transfer", "Reason", transfer.reason or ""),
        row("Transfer", "Created by", creator_name(transfer)),
        row("Transfer", "Remarks", transfer.remarks or ""),
    ]
    for index, line in enumerate(transfer.lines, start=1):
        section = f"Line {index}"
        rows.extend(
            [
                row(section, "Item", line.item.display_name),
                row(section, "Quantity", fmt_qty(line.quantity)),
                row(section, "FIFO value", fmt_money(line.fifo_value)),
            ]
        )
    return f"Transfer {transfer.reference_number}", rows


def opening_stock_rows(opening):
    rows = [
        row("Opening stock", "Company", opening.company.name),
        row("Opening stock", "Stock book", opening.stock_book.name),
        row("Opening stock", "Reference", opening.reference_number),
        row("Opening stock", "Date", opening.opening_date),
        row("Opening stock", "Created by", creator_name(opening)),
        row("Opening stock", "Remarks", opening.remarks or ""),
    ]
    for index, line in enumerate(opening.lines, start=1):
        section = f"Line {index}"
        rows.extend(
            [
                row(section, "Item", line.item.display_name),
                row(section, "Quantity", fmt_qty(line.quantity)),
                row(section, "Rate", line.rate),
                row(section, "Value", fmt_money(line.value)),
                row(section, "Remarks", line.remarks or ""),
            ]
        )
    return f"Opening Stock {opening.reference_number}", rows


def receivable_rows(receivable):
    party = receivable.customer.name if receivable.customer else receivable.counterparty_company.name
    rows = [
        row("Receivable", "Company", receivable.company.name),
        row("Receivable", "Party", party),
        row("Receivable", "Document", receivable.document_number),
        row("Receivable", "Document date", receivable.document_date),
        row("Receivable", "Due date", receivable.due_date or ""),
        row("Receivable", "Type", receivable.transaction_type or ""),
        row("Receivable", "Total", fmt_money(receivable.total_amount)),
        row("Receivable", "Paid", fmt_money(receivable.paid_amount)),
        row("Receivable", "Balance", fmt_money(receivable.balance_amount)),
        row("Receivable", "Status", receivable.payment_status),
        row("Receivable", "Created by", creator_name(receivable)),
        row("Receivable", "Remarks", receivable.remarks or ""),
    ]
    return f"Receivable {receivable.document_number}", rows


def payable_rows(payable):
    party = payable.supplier.name if payable.supplier else payable.counterparty_company.name
    rows = [
        row("Payable", "Company", payable.company.name),
        row("Payable", "Party", party),
        row("Payable", "Document", payable.document_number),
        row("Payable", "Document date", payable.document_date),
        row("Payable", "Due date", payable.due_date or ""),
        row("Payable", "Type", payable.transaction_type or ""),
        row("Payable", "Total", fmt_money(payable.total_amount)),
        row("Payable", "Paid", fmt_money(payable.paid_amount)),
        row("Payable", "Balance", fmt_money(payable.balance_amount)),
        row("Payable", "Status", payable.payment_status),
        row("Payable", "Created by", creator_name(payable)),
        row("Payable", "Remarks", payable.remarks or ""),
    ]
    return f"Payable {payable.document_number}", rows


def payment_rows(payment):
    party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else ""
    reference = payment.reference_number or str(payment.id)
    rows = [
        row("Payment", "Company", payment.company.name),
        row("Payment", "Type", payment.payment_type),
        row("Payment", "Party", party),
        row("Payment", "Date", payment.payment_date),
        row("Payment", "Mode", payment.mode),
        row("Payment", "Reference", payment.reference_number or ""),
        row("Payment", "Amount", fmt_money(payment.total_amount)),
        row("Payment", "Allocated", fmt_money(payment.allocated_amount)),
        row("Payment", "Unallocated", fmt_money(payment.unallocated_amount)),
        row("Payment", "Created by", creator_name(payment)),
        row("Payment", "Remarks", payment.remarks or ""),
    ]
    for index, allocation in enumerate(payment.allocations, start=1):
        section = f"Allocation {index}"
        rows.extend(
            [
                row(section, "Target type", allocation.target_type),
                row(section, "Target ID", allocation.target_id),
                row(section, "Amount", fmt_money(allocation.amount)),
            ]
        )
    return f"Payment {reference}", rows
