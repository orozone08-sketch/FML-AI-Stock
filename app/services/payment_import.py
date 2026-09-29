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
    raise ValueError("Could not find a Payment Register header row.")


def _cell(row, columns, key):
    index = columns.get(key)
    return row[index] if index is not None and index < len(row) else None


def parse_payment_workbook(file_stream, filename="workbook"):
    try:
        workbook = load_workbook(file_stream, read_only=True, data_only=True)
    except Exception as exc:
        raise ValueError("This file is not a supported Excel workbook.") from exc
    if not workbook.sheetnames:
        raise ValueError("The workbook has no worksheets.")
    sheet = workbook[workbook.sheetnames[0]]
    rows = list(sheet.iter_rows(values_only=True))
    header, columns = _columns(rows)
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
        raise ValueError("No payment vouchers were found in the workbook.")
    return {
        "filename": filename, "sheet": sheet.title, "payments": payments,
        "payment_count": len(payments),
    }


def _key(value):
    return " ".join(str(value or "").casefold().split())


def _party(name):
    key = _key(name)
    supplier = Supplier.query.filter(Supplier.active.is_(True)).all()
    for record in supplier:
        if _key(record.name) == key or _key(record.code) == key:
            return "SUPPLIER", record
    customer = Customer.query.filter(Customer.active.is_(True)).all()
    for record in customer:
        if _key(record.name) == key or _key(record.code) == key:
            return "CUSTOMER", record
    return None, None


def import_payment_workbook(preview, company_id, user):
    company = db.session.get(Company, int(company_id or 0))
    if not company or not company.active:
        raise ValueError("Select an active company.")
    result = {"created": [], "skipped": [], "unsupported": 0}
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
        party_type, party = _party(row["particulars"])
        if not party:
            result["unsupported"] += 1
            result["skipped"].append({
                "voucher_number": voucher,
                "reason": "No exact active customer or supplier match. This row may be a bank, salary, tax, or expense ledger entry.",
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
