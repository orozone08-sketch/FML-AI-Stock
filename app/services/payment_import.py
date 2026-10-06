from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from openpyxl import load_workbook

from app.extensions import db
from app.models import Company, Customer, Payment, Supplier
from app.services.payments import create_customer_receipt, create_supplier_payment


HEADERS = {
    "date": "Date", "particulars": "Particulars",
    "voucher_type": "Voucher Type", "voucher_number": "Voucher No.",
    "gross_total": "Gross Total",
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
    return value if isinstance(value, date) else None


def _columns(rows):
    for index, row in enumerate(rows[:30]):
        found = {_text(value).casefold(): i for i, value in enumerate(row)}
        if {"date", "particulars", "voucher no.", "gross total"}.issubset(found):
            return index, {key: found.get(label.casefold()) for key, label in HEADERS.items()}
    raise ValueError("Could not find a Payment or Receipt Register header row.")


def _cell(row, columns, key):
    index = columns.get(key)
    return row[index] if index is not None and index < len(row) else None


def _normalise_kind(value):
    value = _text(value).casefold()
    if value in {"receipt", "receipts", "customer receipt", "customer receipts"}:
        return "receipt"
    if value in {"payment", "payments", "supplier payment", "supplier payments"}:
        return "payment"
    return None


def _infer_kind(sheet, rows, header, columns):
    sheet_kind = _normalise_kind(sheet.title)
    if sheet_kind:
        return sheet_kind
    kinds = {_normalise_kind(_cell(row, columns, "voucher_type")) for row in rows[header + 1:]}
    kinds.discard(None)
    if len(kinds) == 1:
        return kinds.pop()
    return None


def parse_payment_workbook(file_stream, filename="workbook", transaction_kind=None):
    try:
        workbook = load_workbook(file_stream, read_only=True, data_only=True)
    except Exception as exc:
        raise ValueError("This file is not a supported Excel workbook.") from exc
    if not workbook.sheetnames:
        raise ValueError("The workbook has no worksheets.")
    sheet = workbook[workbook.sheetnames[0]]
    rows = list(sheet.iter_rows(values_only=True))
    header, columns = _columns(rows)
    entry_type = _infer_kind(sheet, rows, header, columns)
    expected = _normalise_kind(transaction_kind)
    if expected and entry_type and expected != entry_type:
        expected_label = "receipt" if expected == "receipt" else "payment"
        actual_label = "receipt" if entry_type == "receipt" else "payment"
        raise ValueError(f"This looks like a {actual_label} register. Use the {expected_label} Excel import.")
    if expected:
        entry_type = expected
    payments = []
    for row in rows[header + 1:]:
        particulars = _text(_cell(row, columns, "particulars"))
        voucher = _text(_cell(row, columns, "voucher_number"))
        payment_date = _date(_cell(row, columns, "date"))
        if not particulars or particulars.casefold() in {"grand total", "total"}:
            continue
        if not payment_date or not voucher:
            continue
        amount = _decimal(_cell(row, columns, "gross_total"))
        payments.append({
            "date": payment_date, "particulars": particulars, "voucher_number": voucher,
            "voucher_type": _text(_cell(row, columns, "voucher_type")),
            "amount": amount,
        })
    if not payments:
        label = "receipt" if expected == "receipt" else "payment"
        raise ValueError(f"No {label} vouchers were found in the workbook.")
    label = "Receipt" if entry_type == "receipt" else "Payment" if entry_type == "payment" else "Payment or Receipt"
    return {
        "filename": filename, "sheet": sheet.title, "payments": payments,
        "payment_count": len(payments), "entry_type": entry_type,
        "entry_label": label,
    }


def parse_receipt_workbook(file_stream, filename="workbook"):
    return parse_payment_workbook(file_stream, filename, transaction_kind="receipt")


def parse_supplier_payment_workbook(file_stream, filename="workbook"):
    return parse_payment_workbook(file_stream, filename, transaction_kind="payment")


def _key(value):
    return " ".join(str(value or "").casefold().split())


def _party(name, party_type=None):
    key = _key(name)
    if party_type in (None, "SUPPLIER"):
        for record in Supplier.query.filter(Supplier.active.is_(True)).all():
            if _key(record.name) == key or _key(record.code) == key:
                return "SUPPLIER", record
    if party_type in (None, "CUSTOMER"):
        for record in Customer.query.filter(Customer.active.is_(True)).all():
            if _key(record.name) == key or _key(record.code) == key:
                return "CUSTOMER", record
    return None, None


def import_payment_workbook(preview, company_id, user, transaction_kind=None):
    company = db.session.get(Company, int(company_id or 0))
    if not company or not company.active:
        raise ValueError("Select an active company.")
    expected = _normalise_kind(transaction_kind) or preview.get("entry_type")
    party_type_filter = "SUPPLIER" if expected == "payment" else "CUSTOMER" if expected == "receipt" else None
    result = {"created": [], "skipped": [], "unsupported": 0, "entry_type": expected}
    for row in preview["payments"]:
        voucher = row["voucher_number"]
        amount = row["amount"]
        if amount <= 0:
            result["skipped"].append({"voucher_number": voucher, "reason": "Amount is zero or negative."})
            continue
        existing = Payment.query.filter_by(
            company_id=company.id, payment_date=row["date"],
            reference_number=voucher, total_amount=amount,
        ).first()
        if existing:
            result["skipped"].append({"voucher_number": voucher, "reason": "Payment already exists."})
            continue
        party_type, party = _party(row["particulars"], party_type_filter)
        if not party:
            result["unsupported"] += 1
            expected_party = "active supplier" if party_type_filter == "SUPPLIER" else "active customer" if party_type_filter == "CUSTOMER" else "active customer or supplier"
            result["skipped"].append({
                "voucher_number": voucher,
                "reason": f"No exact {expected_party} match. Bank, salary, tax, expense, or unmatched ledger rows are skipped.",
            })
            continue
        data = {
            "company_id": company.id, "payment_date": row["date"].isoformat(),
            "mode": "BANK", "reference_number": voucher, "amount": amount,
            "remarks": f"Imported from {preview['filename']}. Original particulars: {row['particulars']}",
        }
        try:
            with db.session.begin_nested():
                if party_type == "SUPPLIER":
                    payment = create_supplier_payment({**data, "supplier_id": party.id}, user)
                else:
                    payment = create_customer_receipt({**data, "customer_id": party.id}, user)
            result["created"].append({
                "voucher_number": payment.reference_number,
                "party": party.name,
                "type": party_type,
                "amount": payment.total_amount,
            })
        except Exception as exc:
            result["skipped"].append({"voucher_number": voucher, "reason": str(exc)})
    return result


def import_receipt_workbook(preview, company_id, user):
    return import_payment_workbook(preview, company_id, user, transaction_kind="receipt")


def import_supplier_payment_workbook(preview, company_id, user):
    return import_payment_workbook(preview, company_id, user, transaction_kind="payment")