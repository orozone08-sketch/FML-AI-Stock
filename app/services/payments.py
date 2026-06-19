from decimal import Decimal

from app.core.formatting import money, payment_status, positive_money
from app.extensions import db
from app.models import Payable, Payment, PaymentAllocation, Purchase, Receivable, Sale
from app.services.audit import audit
from app.services.validators import active_customer, active_supplier, parse_date


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
    receivable_id = data.get("receivable_id")
    if receivable_id:
        receivable = db.session.get(Receivable, int(receivable_id))
        if not receivable:
            raise ValueError("Selected invoice was not found.")
        allocate_to_receivable(payment, receivable, amount)
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
    payable_id = data.get("payable_id")
    if payable_id:
        payable = db.session.get(Payable, int(payable_id))
        if not payable:
            raise ValueError("Selected bill was not found.")
        allocate_to_payable(payment, payable, amount)
    audit(
        "create",
        "Payment",
        payment.id,
        payment.reference_number,
        after={"type": payment.payment_type, "amount": payment.total_amount},
        user=user,
    )
    return payment
