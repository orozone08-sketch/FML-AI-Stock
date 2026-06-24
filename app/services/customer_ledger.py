from collections import defaultdict
from datetime import date
from decimal import Decimal

from app.core.formatting import money
from app.models import Payment, Receivable


def month_key(value):
    return f"{value.year:04d}-{value.month:02d}"


def month_label(key):
    year, month = key.split("-")
    return date(int(year), int(month), 1).strftime("%B %Y")


def month_bounds(key):
    year_text, month_text = key.split("-")
    year = int(year_text)
    month = int(month_text)
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)
    return start, end


def receivable_particulars(receivable):
    if receivable.is_opening:
        return "Opening receivable"
    if receivable.source_type == "SALE":
        return f"Sales {receivable.transaction_type or ''}".strip()
    return receivable.source_type.replace("_", " ").title()


def receivable_voucher_type(receivable):
    if receivable.is_opening:
        return "Opening"
    if receivable.source_type == "SALE":
        return "Sales"
    return receivable.source_type.replace("_", " ").title()


def payment_particulars(payment):
    if payment.payment_type == "OPENING_ADVANCE_RECEIVED":
        return "Opening advance received"
    return payment.mode or "Receipt"


def payment_voucher_type(payment):
    if payment.payment_type == "OPENING_ADVANCE_RECEIVED":
        return "Opening"
    return "Receipt"


def customer_ledger_entries(company_id=None, customer_id=None):
    receivables = Receivable.query.filter(Receivable.customer_id.isnot(None))
    payments = Payment.query.filter(Payment.customer_id.isnot(None))
    if company_id:
        receivables = receivables.filter(Receivable.company_id == company_id)
        payments = payments.filter(Payment.company_id == company_id)
    if customer_id:
        receivables = receivables.filter(Receivable.customer_id == customer_id)
        payments = payments.filter(Payment.customer_id == customer_id)

    entries = []
    for receivable in receivables.order_by(Receivable.document_date, Receivable.id).all():
        entries.append(
            {
                "company_id": receivable.company_id,
                "company": receivable.company.code,
                "customer_id": receivable.customer_id,
                "customer": receivable.customer.name,
                "date": receivable.document_date,
                "particulars": receivable_particulars(receivable),
                "voucher_type": receivable_voucher_type(receivable),
                "voucher_no": receivable.document_number,
                "debit": money(receivable.total_amount),
                "credit": Decimal("0.00"),
                "is_bill": True,
                "sort": (receivable.document_date, 0, receivable.id),
            }
        )

    for payment in payments.order_by(Payment.payment_date, Payment.id).all():
        entries.append(
            {
                "company_id": payment.company_id,
                "company": payment.company.code,
                "customer_id": payment.customer_id,
                "customer": payment.customer.name,
                "date": payment.payment_date,
                "particulars": payment_particulars(payment),
                "voucher_type": payment_voucher_type(payment),
                "voucher_no": payment.reference_number or f"PAY-{payment.id}",
                "debit": Decimal("0.00"),
                "credit": money(payment.total_amount),
                "is_bill": False,
                "sort": (payment.payment_date, 1, payment.id),
            }
        )

    return sorted(entries, key=lambda entry: (entry["company"], entry["customer"], entry["sort"]))


def ledger_metrics(entries):
    total_debit = money(sum((entry["debit"] for entry in entries), Decimal("0.00")))
    total_credit = money(sum((entry["credit"] for entry in entries), Decimal("0.00")))
    return {
        "customers": len({(entry["company_id"], entry["customer_id"]) for entry in entries}),
        "bills": sum(1 for entry in entries if entry["is_bill"]),
        "debit": total_debit,
        "credit": total_credit,
        "balance": money(total_debit - total_credit),
    }


def monthly_customer_summary(entries):
    groups = {}
    running = defaultdict(lambda: Decimal("0.00"))
    for entry in sorted(entries, key=lambda item: (item["company"], item["customer"], item["date"], item["sort"])):
        party_key = (entry["company_id"], entry["customer_id"])
        running[party_key] = money(running[party_key] + entry["debit"] - entry["credit"])
        key = (entry["company_id"], entry["customer_id"], month_key(entry["date"]))
        group = groups.setdefault(
            key,
            {
                "company_id": entry["company_id"],
                "company": entry["company"],
                "customer_id": entry["customer_id"],
                "customer": entry["customer"],
                "month_key": month_key(entry["date"]),
                "month": month_label(month_key(entry["date"])),
                "bills": 0,
                "debit": Decimal("0.00"),
                "credit": Decimal("0.00"),
                "closing": Decimal("0.00"),
            },
        )
        if entry["is_bill"]:
            group["bills"] += 1
        group["debit"] = money(group["debit"] + entry["debit"])
        group["credit"] = money(group["credit"] + entry["credit"])
        group["closing"] = running[party_key]
    return sorted(groups.values(), key=lambda row: (row["company"], row["customer"], row["month_key"]))


def ledger_detail(entries, company_id, customer_id, month):
    start, end = month_bounds(month)
    opening = Decimal("0.00")
    rows = []
    balance = Decimal("0.00")
    for entry in sorted(entries, key=lambda item: (item["date"], item["sort"])):
        if entry["company_id"] != company_id or entry["customer_id"] != customer_id:
            continue
        movement = money(entry["debit"] - entry["credit"])
        if entry["date"] < start:
            opening = money(opening + movement)
            continue
        if entry["date"] >= end:
            continue
        if not rows:
            balance = opening
        balance = money(balance + movement)
        rows.append({**entry, "balance": balance})
    closing = rows[-1]["balance"] if rows else opening
    return {
        "month": month,
        "month_label": month_label(month),
        "opening": opening,
        "closing": closing,
        "debit": money(sum((row["debit"] for row in rows), Decimal("0.00"))),
        "credit": money(sum((row["credit"] for row in rows), Decimal("0.00"))),
        "bills": sum(1 for row in rows if row["is_bill"]),
        "rows": rows,
    }
