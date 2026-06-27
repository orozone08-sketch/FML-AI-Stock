from decimal import Decimal

from app.core.formatting import money
from app.extensions import db
from app.models import Company, Payable, Payment, Purchase, Supplier


def supplier_companies(supplier_id):
    company_ids = set()
    for model, column in (
        (Purchase, Purchase.company_id),
        (Payable, Payable.company_id),
        (Payment, Payment.company_id),
    ):
        query = db.session.query(column).filter(model.supplier_id == supplier_id)
        if hasattr(model, "is_void"):
            query = query.filter(model.is_void.is_(False))
        company_ids.update(row[0] for row in query.distinct().all())
    return [company for company in Company.query.filter(Company.id.in_(company_ids or {0})).order_by(Company.code).all()]


def supplier_purchases(supplier_id, company_id=None, date_from=None, date_to=None):
    query = Purchase.query.filter_by(supplier_id=supplier_id, is_void=False)
    if company_id:
        query = query.filter(Purchase.company_id == company_id)
    if date_from:
        query = query.filter(Purchase.bill_date >= date_from)
    if date_to:
        query = query.filter(Purchase.bill_date <= date_to)
    return query.order_by(Purchase.bill_date.desc(), Purchase.id.desc()).all()


def supplier_payables(supplier_id, company_id=None, date_from=None, date_to=None):
    query = Payable.query.filter_by(supplier_id=supplier_id)
    if company_id:
        query = query.filter(Payable.company_id == company_id)
    if date_from:
        query = query.filter(Payable.document_date >= date_from)
    if date_to:
        query = query.filter(Payable.document_date <= date_to)
    return query.order_by(Payable.document_date.desc(), Payable.id.desc()).all()


def supplier_payments(supplier_id, company_id=None, date_from=None, date_to=None):
    query = Payment.query.filter_by(supplier_id=supplier_id)
    if company_id:
        query = query.filter(Payment.company_id == company_id)
    if date_from:
        query = query.filter(Payment.payment_date >= date_from)
    if date_to:
        query = query.filter(Payment.payment_date <= date_to)
    return query.order_by(Payment.payment_date.desc(), Payment.id.desc()).all()


def payable_particulars(payable):
    if payable.is_opening:
        return "Opening payable"
    if payable.source_type == "PURCHASE":
        return f"Purchase {payable.transaction_type or ''}".strip()
    return payable.source_type.replace("_", " ").title()


def supplier_activity_rows(payables, payments):
    entries = []
    for payable in payables:
        entries.append(
            {
                "date": payable.document_date,
                "particulars": payable_particulars(payable),
                "voucher_type": "Purchase" if payable.source_type == "PURCHASE" else "Opening" if payable.is_opening else payable.source_type.title(),
                "voucher_no": payable.document_number,
                "debit": money(payable.total_amount),
                "credit": Decimal("0.00"),
                "sort": (payable.document_date, 0, payable.id),
            }
        )
    for payment in payments:
        entries.append(
            {
                "date": payment.payment_date,
                "particulars": "Opening advance paid" if payment.payment_type == "OPENING_ADVANCE_PAID" else payment.mode,
                "voucher_type": "Payment",
                "voucher_no": payment.reference_number or f"PAY-{payment.id}",
                "debit": Decimal("0.00"),
                "credit": money(payment.total_amount),
                "sort": (payment.payment_date, 1, payment.id),
            }
        )
    balance = Decimal("0.00")
    rows = []
    for entry in sorted(entries, key=lambda row: row["sort"]):
        balance = money(balance + entry["debit"] - entry["credit"])
        rows.append({**entry, "balance": balance})
    return rows


def supplier_transactions(supplier_id, company_id=None, date_from=None, date_to=None):
    supplier = db.session.get(Supplier, supplier_id)
    if not supplier:
        return None
    purchases = supplier_purchases(supplier_id, company_id, date_from, date_to)
    payables = supplier_payables(supplier_id, company_id, date_from, date_to)
    payments = supplier_payments(supplier_id, company_id, date_from, date_to)
    total_purchase = money(sum((purchase.grand_total for purchase in purchases), Decimal("0.00")))
    total_paid = money(sum((payment.total_amount for payment in payments), Decimal("0.00")))
    total_pending = money(sum((payable.balance_amount for payable in payables), Decimal("0.00")))
    last_transaction = max([purchase.bill_date for purchase in purchases] + [payable.document_date for payable in payables], default=None)
    last_payment = max((payment.payment_date for payment in payments), default=None)
    return {
        "supplier": supplier,
        "companies": supplier_companies(supplier_id),
        "purchases": purchases,
        "payables": payables,
        "payments": payments,
        "activity_rows": supplier_activity_rows(payables, payments),
        "summary": {
            "total_purchases": len(purchases),
            "total_purchase_amount": total_purchase,
            "total_paid": total_paid,
            "total_pending": total_pending,
            "last_transaction": last_transaction,
            "last_payment": last_payment,
        },
    }
