from flask import Blueprint, flash, jsonify, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from app.core.forms import item_lines_from_form, transfer_lines_from_form
from app.core.security import require_permission
from app.extensions import db
from app.models import (
    Company,
    Customer,
    Item,
    Payable,
    Payment,
    PaymentMode,
    Purchase,
    Receivable,
    Sale,
    StockBook,
    Supplier,
)
from app.services.references import next_reference
from app.services.transactions import (
    create_opening_advance_paid,
    create_opening_advance_received,
    create_opening_payable,
    create_opening_receivable,
    create_opening_stock,
    create_purchase,
    create_sale,
    create_transfer,
)

bp = Blueprint("transactions", __name__, url_prefix="/transactions")


def options():
    return {
        "companies": Company.query.filter_by(active=True).order_by(Company.code).all(),
        "stock_books": StockBook.query.filter_by(active=True).order_by(StockBook.code).all(),
        "items": Item.query.filter_by(active=True).order_by(Item.code).all(),
        "suppliers": Supplier.query.filter_by(active=True).order_by(Supplier.code).all(),
        "customers": Customer.query.filter_by(active=True).order_by(Customer.code).all(),
        "payment_modes": PaymentMode.query.filter_by(active=True).order_by(PaymentMode.code).all(),
    }


@bp.route("/reference/<kind>")
@login_required
def reference(kind):
    return jsonify({"reference": next_reference(kind)})


@bp.route("/purchase", methods=["GET", "POST"])
@login_required
@require_permission("purchase", "view")
def purchase():
    if request.method == "POST":
        require_permission("purchase", "create")(lambda: None)()
        try:
            purchase = create_purchase(request.form, item_lines_from_form(request.form), current_user)
            db.session.commit()
            flash(f"Purchase {purchase.bill_number} saved.", "success")
            return redirect(url_for("transactions.purchase"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    purchases = Purchase.query.order_by(Purchase.bill_date.desc(), Purchase.id.desc()).limit(20).all()
    return render_template("transactions/purchase.html", purchases=purchases, **options())


@bp.route("/sale", methods=["GET", "POST"])
@login_required
@require_permission("sale", "view")
def sale():
    if request.method == "POST":
        require_permission("sale", "create")(lambda: None)()
        try:
            sale = create_sale(request.form, item_lines_from_form(request.form), current_user)
            db.session.commit()
            flash(f"Sale {sale.invoice_number} saved.", "success")
            return redirect(url_for("transactions.sale"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    sales = Sale.query.order_by(Sale.invoice_date.desc(), Sale.id.desc()).limit(20).all()
    return render_template("transactions/sale.html", sales=sales, **options())


@bp.route("/transfer", methods=["GET", "POST"])
@login_required
@require_permission("transfer", "view")
def transfer():
    if request.method == "POST":
        require_permission("transfer", "create")(lambda: None)()
        try:
            transfer = create_transfer(request.form, transfer_lines_from_form(request.form), current_user)
            db.session.commit()
            flash(f"Transfer {transfer.reference_number} saved.", "success")
            return redirect(url_for("transactions.transfer"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    from app.models import InterCompanyTransfer

    transfers = InterCompanyTransfer.query.order_by(InterCompanyTransfer.transfer_date.desc(), InterCompanyTransfer.id.desc()).limit(20).all()
    return render_template("transactions/transfer.html", transfers=transfers, **options())


@bp.route("/opening", methods=["GET"])
@login_required
@require_permission("opening", "view")
def opening():
    return render_template(
        "transactions/opening.html",
        opening_stock=[],
        receivables=Receivable.query.filter_by(is_opening=True).order_by(Receivable.document_date.desc()).limit(20).all(),
        payables=Payable.query.filter_by(is_opening=True).order_by(Payable.document_date.desc()).limit(20).all(),
        advances=Payment.query.filter(Payment.payment_type.like("OPENING_ADVANCE%")).order_by(Payment.payment_date.desc()).limit(20).all(),
        **options(),
    )


@bp.route("/opening/<section>", methods=["POST"])
@login_required
@require_permission("opening", "create")
def opening_save(section):
    try:
        if section == "stock":
            record = create_opening_stock(request.form, item_lines_from_form(request.form), current_user)
            message = f"Opening stock {record.reference_number} saved."
        elif section == "receivable":
            record = create_opening_receivable(request.form, current_user)
            message = f"Opening receivable {record.document_number} saved."
        elif section == "payable":
            record = create_opening_payable(request.form, current_user)
            message = f"Opening payable {record.document_number} saved."
        elif section == "advance-received":
            record = create_opening_advance_received(request.form, current_user)
            message = "Opening advance received saved."
        elif section == "advance-paid":
            record = create_opening_advance_paid(request.form, current_user)
            message = "Opening advance paid saved."
        else:
            flash("Unknown opening section.", "danger")
            return redirect(url_for("transactions.opening"))
        db.session.commit()
        flash(message, "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("transactions.opening"))
