from decimal import Decimal

from app.core.formatting import money, payment_status, positive_money
from app.extensions import db
from app.models import Company, Payable, Payment, PaymentAllocation, Purchase, Receivable, Sale
from app.services.audit import audit
from app.services.validators import active_customer, active_supplier, parse_date


EDITABLE_PAYMENT_TYPES = {"CUSTOMER_RECEIPT", "SUPPLIER_PAYMENT"}


def sync_receivable(receivable):
    receivable.balance_amount = money(receivable.total_amount - receivable.paid_amount)
    receivable.payment_status = payment_status(receivable.total_amount, receivable.paid_amount)
    if receivable.source_type == "SALE":
        sale = db.session.get(Sale, receivable.source_id)
        if sale:
            sale.paid_amount = receivable.paid_amount
            sale.balance_amount = receivable.balance_amount
            sale.payment_status = receivable.payment_status


def sync_payable(payable):
    payable.balance_amount = money(payable.total_amount - payable.paid_amount)
    payable.payment_status = payment_status(payable.total_amount, payable.paid_amount)
    if payable.source_type == "PURCHASE":
        purchase = db.session.get(Purchase, payable.source_id)
        if purchase:
            purchase.paid_amount = payable.paid_amount
            purchase.balance_amount = payable.balance_amount
            purchase.payment_status = payable.payment_status


def allocate_to_receivable(payment, receivable, amount):
    amount = money(amount)
    if receivable.company_id != payment.company_id:
        raise ValueError("The selected invoice belongs to a different company.")
    if payment.customer_id and receivable.customer_id != payment.customer_id:
        raise ValueError("The selected invoice belongs to a different customer.")
    allocation = money(min(amount, receivable.balance_amount))
    if allocation <= Decimal("0.00"):
        return Decimal("0.00")
    receivable.paid_amount = money(receivable.paid_amount + allocation)
    sync_receivable(receivable)
    payment.allocated_amount = money(payment.allocated_amount + allocation)
    payment.unallocated_amount = money(payment.total_amount - payment.allocated_amount)
    db.session.add(
        PaymentAllocation(
            payment=payment,
            target_type="RECEIVABLE",
            target_id=receivable.id,
            amount=allocation,
        )
    )
    return allocation


def allocate_to_payable(payment, payable, amount):
    amount = money(amount)
    if payable.company_id != payment.company_id:
        raise ValueError("The selected bill belongs to a different company.")
    if payment.supplier_id and payable.supplier_id != payment.supplier_id:
        raise ValueError("The selected bill belongs to a different supplier.")
    allocation = money(min(amount, payable.balance_amount))
    if allocation <= Decimal("0.00"):
        return Decimal("0.00")
    payable.paid_amount = money(payable.paid_amount + allocation)
    sync_payable(payable)
    payment.allocated_amount = money(payment.allocated_amount + allocation)
    payment.unallocated_amount = money(payment.total_amount - payment.allocated_amount)
    db.session.add(
        PaymentAllocation(
            payment=payment,
            target_type="PAYABLE",
            target_id=payable.id,
            amount=allocation,
        )
    )
    return allocation


def allocate_remaining_receivables(payment, amount, exclude_ids=None):
    remaining = money(amount)
    exclude_ids = set(exclude_ids or [])
    if remaining <= Decimal("0.00") or not payment.customer_id:
        return Decimal("0.00")
    allocated = Decimal("0.00")
    query = (
        Receivable.query.filter(
            Receivable.company_id == payment.company_id,
            Receivable.customer_id == payment.customer_id,
            Receivable.balance_amount > 0,
        )
        .order_by(Receivable.due_date, Receivable.document_date, Receivable.id)
    )
    for receivable in query.all():
        if receivable.id in exclude_ids:
            continue
        applied = allocate_to_receivable(payment, receivable, remaining)
        allocated = money(allocated + applied)
        remaining = money(remaining - applied)
        if remaining <= Decimal("0.00"):
            break
    return allocated


def allocate_remaining_payables(payment, amount, exclude_ids=None):
    remaining = money(amount)
    exclude_ids = set(exclude_ids or [])
    if remaining <= Decimal("0.00") or not payment.supplier_id:
        return Decimal("0.00")
    allocated = Decimal("0.00")
    query = (
        Payable.query.filter(
            Payable.company_id == payment.company_id,
            Payable.supplier_id == payment.supplier_id,
            Payable.balance_amount > 0,
        )
        .order_by(Payable.due_date, Payable.document_date, Payable.id)
    )
    for payable in query.all():
        if payable.id in exclude_ids:
            continue
        applied = allocate_to_payable(payment, payable, remaining)
        allocated = money(allocated + applied)
        remaining = money(remaining - applied)
        if remaining <= Decimal("0.00"):
            break
    return allocated


def allocate_customer_receipt(payment, receivable_id):
    if not receivable_id:
        return Decimal("0.00")
    receivable = db.session.get(Receivable, int(receivable_id))
    if not receivable:
        raise ValueError("Selected invoice was not found.")
    first_allocation = allocate_to_receivable(payment, receivable, payment.unallocated_amount)
    remaining = money(payment.unallocated_amount)
    if remaining > Decimal("0.00"):
        allocate_remaining_receivables(payment, remaining, exclude_ids={receivable.id})
    return first_allocation


def allocate_supplier_payment(payment, payable_id):
    if not payable_id:
        return Decimal("0.00")
    payable = db.session.get(Payable, int(payable_id))
    if not payable:
        raise ValueError("Selected bill was not found.")
    first_allocation = allocate_to_payable(payment, payable, payment.unallocated_amount)
    remaining = money(payment.unallocated_amount)
    if remaining > Decimal("0.00"):
        allocate_remaining_payables(payment, remaining, exclude_ids={payable.id})
    return first_allocation


def payment_snapshot(payment):
    return {
        "company_id": payment.company_id,
        "payment_type": payment.payment_type,
        "party_type": payment.party_type,
        "customer_id": payment.customer_id,
        "supplier_id": payment.supplier_id,
        "payment_date": payment.payment_date,
        "mode": payment.mode,
        "reference_number": payment.reference_number,
        "total_amount": payment.total_amount,
        "allocated_amount": payment.allocated_amount,
        "unallocated_amount": payment.unallocated_amount,
        "allocations": [
            {
                "target_type": allocation.target_type,
                "target_id": allocation.target_id,
                "amount": allocation.amount,
            }
            for allocation in payment.allocations
        ],
    }


def ensure_editable_payment(payment):
    if payment.payment_type not in EDITABLE_PAYMENT_TYPES:
        raise ValueError("Only customer receipts and supplier payments can be edited from Payments.")


def reverse_payment_allocations(payment):
    for allocation in list(payment.allocations):
        amount = money(allocation.amount)
        if allocation.target_type == "RECEIVABLE":
            receivable = db.session.get(Receivable, allocation.target_id)
            if receivable:
                receivable.paid_amount = money(max(receivable.paid_amount - amount, Decimal("0.00")))
                sync_receivable(receivable)
        elif allocation.target_type == "PAYABLE":
            payable = db.session.get(Payable, allocation.target_id)
            if payable:
                payable.paid_amount = money(max(payable.paid_amount - amount, Decimal("0.00")))
                sync_payable(payable)
        db.session.delete(allocation)
    payment.allocated_amount = Decimal("0.00")
    payment.unallocated_amount = money(payment.total_amount)


def update_payment(payment, data, user):
    ensure_editable_payment(payment)
    company = db.session.get(Company, int(data.get("company_id") or payment.company_id))
    if not company or not company.active:
        raise ValueError("Company is required.")
    before = payment_snapshot(payment)
    reverse_payment_allocations(payment)
    amount = positive_money(data.get("amount"), "Payment amount")

    payment.company_id = company.id
    payment.payment_date = parse_date(data.get("payment_date"), "Payment date")
    payment.mode = data.get("mode") or payment.mode or "CASH"
    payment.reference_number = data.get("reference_number") or None
    payment.total_amount = amount
    payment.allocated_amount = Decimal("0.00")
    payment.unallocated_amount = amount
    payment.remarks = data.get("remarks") or None
    payment.updated_by_id = getattr(user, "id", None)

    if payment.payment_type == "CUSTOMER_RECEIPT":
        customer = active_customer(data.get("customer_id") or payment.customer_id)
        payment.party_type = "CUSTOMER"
        payment.customer_id = customer.id
        payment.supplier_id = None
        allocate_customer_receipt(payment, data.get("receivable_id"))
    else:
        supplier = active_supplier(data.get("supplier_id") or payment.supplier_id)
        payment.party_type = "SUPPLIER"
        payment.supplier_id = supplier.id
        payment.customer_id = None
        allocate_supplier_payment(payment, data.get("payable_id"))

    audit("edit", "Payment", payment.id, payment.reference_number, before=before, after=payment_snapshot(payment), user=user)
    return payment


def delete_payment(payment, user):
    ensure_editable_payment(payment)
    before = payment_snapshot(payment)
    reference = payment.reference_number or str(payment.id)
    reverse_payment_allocations(payment)
    db.session.delete(payment)
    audit("delete", "Payment", payment.id, reference, before=before, user=user)
    return payment


def create_customer_receipt(data, user):
    customer = active_customer(data.get("customer_id"))
    amount = positive_money(data.get("amount"), "Receipt amount")
    payment_date = parse_date(data.get("payment_date"), "Receipt date")
    payment = Payment(
        company_id=int(data["company_id"]),
        payment_type="CUSTOMER_RECEIPT",
        party_type="CUSTOMER",
        customer_id=customer.id,
        payment_date=payment_date,
        mode=data.get("mode") or "CASH",
        reference_number=data.get("reference_number") or None,
        total_amount=amount,
        allocated_amount=Decimal("0.00"),
        unallocated_amount=amount,
        remarks=data.get("remarks") or None,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(payment)
    db.session.flush()
    allocate_customer_receipt(payment, data.get("receivable_id"))
    audit(
        "create",
        "Payment",
        payment.id,
        payment.reference_number,
        after={"type": payment.payment_type, "amount": payment.total_amount},
        user=user,
    )
    return payment


def create_supplier_payment(data, user):
    supplier = active_supplier(data.get("supplier_id"))
    amount = positive_money(data.get("amount"), "Payment amount")
    payment_date = parse_date(data.get("payment_date"), "Payment date")
    payment = Payment(
        company_id=int(data["company_id"]),
        payment_type="SUPPLIER_PAYMENT",
        party_type="SUPPLIER",
        supplier_id=supplier.id,
        payment_date=payment_date,
        mode=data.get("mode") or "CASH",
        reference_number=data.get("reference_number") or None,
        total_amount=amount,
        allocated_amount=Decimal("0.00"),
        unallocated_amount=amount,
        remarks=data.get("remarks") or None,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(payment)
    db.session.flush()
    allocate_supplier_payment(payment, data.get("payable_id"))
    audit(
        "create",
        "Payment",
        payment.id,
        payment.reference_number,
        after={"type": payment.payment_type, "amount": payment.total_amount},
        user=user,
    )
    return payment
