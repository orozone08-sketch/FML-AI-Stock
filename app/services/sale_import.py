from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from openpyxl import load_workbook


HEADER_NAMES = {
    "date": "Date",
    "particulars": "Particulars",
    "voucher_type": "Voucher Type",
    "voucher_number": "Voucher No.",
    "payment_terms": "Terms of Payment",
    "delivery_terms": "Terms of Delivery",
    "quantity": "Quantity",
    "rate": "Rate",
    "value": "Value",
    "gross_total": "Gross Total",
    "igst": "Output IGST @ 18%",
    "cgst": "Output CGST @ 9%",
    "sgst": "Output SGST @ 9%",
    "round_off": "Round Off",
}


def _text(value):
    return " ".join(str(value or "").strip().split())


def _decimal(value, default=Decimal("0.00")):
    if value in (None, ""):
        return default
    try:
        return Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return default


def _date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return None


def _header_map(rows):
    for index, row in enumerate(rows[:30]):
        values = {_text(value).casefold(): column for column, value in enumerate(row)}
        if {"date", "particulars", "voucher no."}.issubset(values):
            return index, {
                key: values.get(label.casefold())
                for key, label in HEADER_NAMES.items()
            }
    raise ValueError("Could not find a Sales Register header row.")


def _value(row, columns, key):
    column = columns.get(key)
    return row[column] if column is not None and column < len(row) else None


def parse_sales_workbook(file_stream, filename="workbook"):
    try:
        workbook = load_workbook(file_stream, read_only=True, data_only=True)
    except Exception as exc:
        raise ValueError("This file is not a supported Excel workbook.") from exc

    if not workbook.sheetnames:
        raise ValueError("The workbook has no worksheets.")
    sheet = workbook[workbook.sheetnames[0]]
    rows = list(sheet.iter_rows(values_only=True))
    header_index, columns = _header_map(rows)
    invoices = []
    current = None

    for row in rows[header_index + 1 :]:
        particulars = _text(_value(row, columns, "particulars"))
        if not particulars:
            continue
        if particulars.casefold() in {"grand total", "total"}:
            continue

        voucher_number = _text(_value(row, columns, "voucher_number"))
        voucher_type = _text(_value(row, columns, "voucher_type"))
        invoice_date = _date(_value(row, columns, "date"))
        is_invoice = bool(voucher_number and (invoice_date or voucher_type))

        if is_invoice:
            gst = sum(
                (_decimal(_value(row, columns, key)) for key in ("igst", "cgst", "sgst")),
                Decimal("0.00"),
            )
            subtotal = _decimal(_value(row, columns, "value"))
            grand_total = _decimal(_value(row, columns, "gross_total"), subtotal + gst)
            current = {
                "date": invoice_date,
                "customer": particulars,
                "invoice_number": voucher_number,
                "payment_terms": _text(_value(row, columns, "payment_terms")),
                "delivery_terms": _text(_value(row, columns, "delivery_terms")),
                "subtotal": subtotal,
                "gst_total": gst,
                "grand_total": grand_total,
                "round_off": _decimal(_value(row, columns, "round_off")),
                "lines": [],
            }
            invoices.append(current)
            continue

        if current is None:
            continue
        quantity = _decimal(_value(row, columns, "quantity"), None)
        rate = _decimal(_value(row, columns, "rate"), None)
        value = _decimal(_value(row, columns, "value"), None)
        if quantity is None and rate is None and value is None:
            continue
        current["lines"].append(
            {
                "item": particulars,
                "quantity": quantity or Decimal("0.000"),
                "rate": rate or Decimal("0.00"),
                "value": value or Decimal("0.00"),
            }
        )

    if not invoices:
        raise ValueError("No sales invoices were found in the workbook.")
    return {
        "filename": filename,
        "sheet": sheet.title,
        "invoices": invoices,
        "invoice_count": len(invoices),
        "line_count": sum(len(invoice["lines"]) for invoice in invoices),
    }