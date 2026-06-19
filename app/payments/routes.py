from flask import Blueprint, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from app.core.security import require_permission
from app.extensions import db
from app.models import Company, Customer, Payable, Payment, PaymentMode, Receivable, Supplier
from app.services.payments import create_customer_receipt, create_supplier_payment

bp = Blueprint("payments", __name__, url_prefix="/finance")


def finance_options():
    return {
        "companies": Company.query.filter_by(active=True).order_by(Company.code).all(),
        "customers": Customer.query.filter_by(active=True).order_by(Customer.code).all(),
        "suppliers": Supplier.query.filter_by(active=True).order_by(Supplier.code).all(),
        "payment_modes": PaymentMode.query.filter_by(active=True).order_by(PaymentMode.code).all(),
        "receivables": Receivable.query.filter(Receivable.balance_amount > 0).order_by(Receivable.due_date, Receivable.document_number).all(),
        "payables": Payable.query.filter(Payable.balance_amount > 0).order_by(Payable.due_date, Payable.document_number).all(),
    }


@bp.route("/payments", methods=["GET"])
@login_required
@require_permission("payments", "view")
def index():
    recent_payments = Payment.query.order_by(Payment.payment_date.desc(), Payment.id.desc()).limit(30).all()
    return render_template("payments/index.html", recent_payments=recent_payments, **finance_options())


@bp.route("/payments/customer-receipt", methods=["POST"])
@login_required
@require_permission("payments", "create")
def customer_receipt():
    try:
        payment = create_customer_receipt(request.form, current_user)
        db.session.commit()
        flash(f"Customer receipt for {payment.total_amount} saved.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("payments.index"))


@bp.route("/payments/supplier-payment", methods=["POST"])
@login_required
@require_permission("payments", "create")
def supplier_payment():
    try:
        payment = create_supplier_payment(request.form, current_user)
        db.session.commit()
        flash(f"Supplier payment for {payment.total_amount} saved.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("payments.index"))


@bp.route("/outstanding")
@login_required
@require_permission("outstanding", "view")
def outstanding():
    company_id = request.args.get("company_id")
    status = request.args.get("status")
    receivables = Receivable.query
    payables = Payable.query
    if company_id:
        receivables = receivables.filter_by(company_id=company_id)
        payables = payables.filter_by(company_id=company_id)
    if status:
        receivables = receivables.filter_by(payment_status=status)
        payables = payables.filter_by(payment_status=status)
    receivables = receivables.order_by(Receivable.due_date, Receivable.document_date).all()
    payables = payables.order_by(Payable.due_date, Payable.document_date).all()
    advances = Payment.query.filter(Payment.unallocated_amount > 0).order_by(Payment.payment_date.desc()).all()
    return render_template(
        "payments/outstanding.html",
        receivables=receivables,
        payables=payables,
        advances=advances,
        companies=Company.query.filter_by(active=True).order_by(Company.code).all(),
    )
