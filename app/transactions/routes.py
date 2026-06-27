from flask import Blueprint, abort, flash, jsonify, redirect, render_template, request, url_for
from flask_login import current_user, login_required

from app.core.company_context import active_company
from app.core.forms import item_lines_from_form, transfer_lines_from_form
from app.core.security import can, require_permission
from app.extensions import db
from app.models import (
    Company,
    Customer,
    InterCompanyTransfer,
    Item,
    OpeningStock,
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
from app.services.entry_exports import (
    export_entry,
    opening_stock_rows,
    payable_rows,
    purchase_rows,
    receivable_rows,
    sale_rows,
    transfer_rows,
    payment_rows,
    print_entry,
)
from app.services.transactions import (
    create_opening_advance_paid,
    create_opening_advance_received,
    create_opening_payable,
    create_opening_pending_stock,
    create_opening_receivable,
    create_opening_stock,
    create_purchase,
    create_sale,
    create_transfer,
    delete_opening_advance,
    delete_opening_payable,
    delete_opening_receivable,
    pending_transfer_summary,
    update_opening_advance,
    update_opening_payable,
    update_opening_receivable,
    update_opening_stock,
    update_purchase_header,
    update_purchase_lines,
    update_sale_header,
    update_sale_lines,
    update_transfer_header,
    void_opening_stock,
    void_purchase,
    void_sale,
    void_transfer,
)

bp = Blueprint("transactions", __name__, url_prefix="/transactions")


def options(scope_to_active_company=False):
    company = active_company() if scope_to_active_company else None
    companies = Company.query.filter_by(active=True)
    stock_books = StockBook.query.filter_by(active=True)
    if company:
        companies = companies.filter(Company.id == company.id)
        stock_books = stock_books.filter(StockBook.company_id == company.id)
    return {
        "companies": companies.order_by(Company.code).all(),
        "stock_books": stock_books.order_by(StockBook.code).all(),
        "items": Item.query.filter_by(active=True).order_by(Item.code).all(),
        "suppliers": Supplier.query.filter_by(active=True).order_by(Supplier.code).all(),
        "customers": Customer.query.filter_by(active=True).order_by(Customer.code).all(),
        "payment_modes": PaymentMode.query.filter_by(active=True).order_by(PaymentMode.code).all(),
    }


def active_company_id():
    company = active_company()
    return company.id if company else None


def require_active_company_value(company_id):
    company = active_company()
    if company and str(company_id or "") != str(company.id):
        raise ValueError("This login can record transactions only for the active company.")


def require_active_company_document(*company_ids):
    company = active_company()
    if company and company.id not in {int(value) for value in company_ids if value}:
        abort(403)


def require_transfer_scope(data):
    company = active_company()
    if not company:
        return
    selected = {str(data.get("from_company_id") or ""), str(data.get("to_company_id") or "")}
    if str(company.id) not in selected:
        raise ValueError("Transfers must include the active company.")


def export_response(title_rows, fmt):
    try:
        title, rows = title_rows
        return export_entry(title, rows, fmt)
    except ValueError:
        abort(404)


def print_response(title_rows):
    title, rows = title_rows
    return print_entry(title, rows)


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
            require_active_company_value(request.form.get("company_id"))
            purchase = create_purchase(request.form, item_lines_from_form(request.form), current_user)
            db.session.commit()
            flash(f"Purchase {purchase.bill_number} saved.", "success")
            return redirect(url_for("transactions.purchase"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    purchases = Purchase.query.filter_by(is_void=False)
    company_id = active_company_id()
    if company_id:
        purchases = purchases.filter(Purchase.company_id == company_id)
    purchases = purchases.order_by(Purchase.bill_date.desc(), Purchase.id.desc()).limit(20).all()
    return render_template("transactions/purchase.html", purchases=purchases, **options(scope_to_active_company=True))


@bp.route("/purchase/<int:purchase_id>/edit", methods=["GET", "POST"])
@login_required
def purchase_edit(purchase_id):
    if not (can(current_user, "purchase", "edit") or can(current_user, "purchase", "create")):
        abort(403)
    purchase = db.session.get(Purchase, purchase_id)
    if not purchase:
        flash("Purchase not found.", "danger")
        return redirect(url_for("transactions.purchase"))
    require_active_company_document(purchase.company_id)
    if request.method == "POST":
        try:
            require_active_company_value(request.form.get("company_id") or purchase.company_id)
            update_purchase_header(purchase, request.form, current_user)
            update_purchase_lines(purchase, item_lines_from_form(request.form), request.form, current_user)
            db.session.commit()
            flash(f"Purchase {purchase.bill_number} updated.", "success")
            return redirect(url_for("transactions.purchase"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("transactions/purchase_edit.html", purchase=purchase, **options(scope_to_active_company=True))


@bp.route("/purchase/<int:purchase_id>/delete", methods=["POST"])
@login_required
def purchase_delete(purchase_id):
    if not (can(current_user, "purchase", "edit") or can(current_user, "purchase", "deactivate")):
        abort(403)
    purchase = db.session.get(Purchase, purchase_id)
    if not purchase:
        flash("Purchase not found.", "danger")
        return redirect(url_for("transactions.purchase"))
    require_active_company_document(purchase.company_id)
    try:
        void_purchase(purchase, current_user)
        db.session.commit()
        flash("Purchase deleted and stock reversed.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("transactions.purchase"))


@bp.route("/purchase/<int:purchase_id>/export/<fmt>")
@login_required
@require_permission("purchase", "view")
def purchase_export(purchase_id, fmt):
    purchase = db.session.get(Purchase, purchase_id)
    if not purchase:
        abort(404)
    require_active_company_document(purchase.company_id)
    return export_response(purchase_rows(purchase), fmt)


@bp.route("/purchase/<int:purchase_id>/print")
@login_required
@require_permission("purchase", "view")
def purchase_print(purchase_id):
    purchase = db.session.get(Purchase, purchase_id)
    if not purchase:
        abort(404)
    require_active_company_document(purchase.company_id)
    return print_response(purchase_rows(purchase))


@bp.route("/sale", methods=["GET", "POST"])
@login_required
@require_permission("sale", "view")
def sale():
    if request.method == "POST":
        require_permission("sale", "create")(lambda: None)()
        try:
            require_active_company_value(request.form.get("company_id"))
            sale = create_sale(request.form, item_lines_from_form(request.form), current_user)
            db.session.commit()
            flash(f"Sale {sale.invoice_number} saved.", "success")
            return redirect(url_for("transactions.sale"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    sales = Sale.query.filter_by(is_void=False)
    company_id = active_company_id()
    if company_id:
        sales = sales.filter(Sale.company_id == company_id)
    sales = sales.order_by(Sale.invoice_date.desc(), Sale.id.desc()).limit(20).all()
    return render_template("transactions/sale.html", sales=sales, **options(scope_to_active_company=True))


@bp.route("/sale/<int:sale_id>/edit", methods=["GET", "POST"])
@login_required
def sale_edit(sale_id):
    if not (can(current_user, "sale", "edit") or can(current_user, "sale", "create")):
        abort(403)
    sale = db.session.get(Sale, sale_id)
    if not sale:
        flash("Sale not found.", "danger")
        return redirect(url_for("transactions.sale"))
    require_active_company_document(sale.company_id)
    if request.method == "POST":
        try:
            require_active_company_value(request.form.get("company_id") or sale.company_id)
            update_sale_header(sale, request.form, current_user)
            update_sale_lines(sale, item_lines_from_form(request.form), current_user)
            db.session.commit()
            flash(f"Sale {sale.invoice_number} updated.", "success")
            return redirect(url_for("transactions.sale"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("transactions/sale_edit.html", sale=sale, **options(scope_to_active_company=True))


@bp.route("/sale/<int:sale_id>/delete", methods=["POST"])
@login_required
def sale_delete(sale_id):
    if not (can(current_user, "sale", "edit") or can(current_user, "sale", "deactivate")):
        abort(403)
    sale = db.session.get(Sale, sale_id)
    if not sale:
        flash("Sale not found.", "danger")
        return redirect(url_for("transactions.sale"))
    require_active_company_document(sale.company_id)
    try:
        void_sale(sale, current_user)
        db.session.commit()
        flash("Sale deleted and stock restored.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("transactions.sale"))


@bp.route("/sale/<int:sale_id>/export/<fmt>")
@login_required
@require_permission("sale", "view")
def sale_export(sale_id, fmt):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        abort(404)
    require_active_company_document(sale.company_id)
    return export_response(sale_rows(sale), fmt)


@bp.route("/sale/<int:sale_id>/print")
@login_required
@require_permission("sale", "view")
def sale_print(sale_id):
    sale = db.session.get(Sale, sale_id)
    if not sale:
        abort(404)
    require_active_company_document(sale.company_id)
    return print_response(sale_rows(sale))


@bp.route("/transfer", methods=["GET", "POST"])
@login_required
@require_permission("transfer", "view")
def transfer():
    if request.method == "POST":
        require_permission("transfer", "create")(lambda: None)()
        try:
            require_transfer_scope(request.form)
            transfer = create_transfer(request.form, transfer_lines_from_form(request.form), current_user)
            db.session.commit()
            flash(f"Transfer {transfer.reference_number} saved.", "success")
            return redirect(url_for("transactions.transfer"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    transfers = InterCompanyTransfer.query.filter_by(is_void=False)
    company_id = active_company_id()
    if company_id:
        transfers = transfers.filter(
            db.or_(
                InterCompanyTransfer.from_company_id == company_id,
                InterCompanyTransfer.to_company_id == company_id,
            )
        )
    transfers = transfers.order_by(InterCompanyTransfer.transfer_date.desc(), InterCompanyTransfer.id.desc()).limit(20).all()
    return render_template(
        "transactions/transfer.html",
        transfers=transfers,
        pending_rows=pending_transfer_summary(),
        **options(),
    )


@bp.route("/transfer/<int:transfer_id>/edit", methods=["GET", "POST"])
@login_required
def transfer_edit(transfer_id):
    if not (can(current_user, "transfer", "edit") or can(current_user, "transfer", "create")):
        abort(403)
    transfer = db.session.get(InterCompanyTransfer, transfer_id)
    if not transfer:
        flash("Transfer not found.", "danger")
        return redirect(url_for("transactions.transfer"))
    require_active_company_document(transfer.from_company_id, transfer.to_company_id)
    if request.method == "POST":
        try:
            require_active_company_document(transfer.from_company_id, transfer.to_company_id)
            update_transfer_header(transfer, request.form, current_user)
            db.session.commit()
            flash(f"Transfer {transfer.reference_number} updated.", "success")
            return redirect(url_for("transactions.transfer"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("transactions/transfer_edit.html", transfer=transfer, **options())


@bp.route("/transfer/<int:transfer_id>/delete", methods=["POST"])
@login_required
def transfer_delete(transfer_id):
    if not (can(current_user, "transfer", "edit") or can(current_user, "transfer", "deactivate")):
        abort(403)
    transfer = db.session.get(InterCompanyTransfer, transfer_id)
    if not transfer:
        flash("Transfer not found.", "danger")
        return redirect(url_for("transactions.transfer"))
    require_active_company_document(transfer.from_company_id, transfer.to_company_id)
    try:
        void_transfer(transfer, current_user)
        db.session.commit()
        flash("Transfer deleted and stock movement reversed.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("transactions.transfer"))


@bp.route("/transfer/<int:transfer_id>/export/<fmt>")
@login_required
@require_permission("transfer", "view")
def transfer_export(transfer_id, fmt):
    transfer = db.session.get(InterCompanyTransfer, transfer_id)
    if not transfer:
        abort(404)
    require_active_company_document(transfer.from_company_id, transfer.to_company_id)
    return export_response(transfer_rows(transfer), fmt)


@bp.route("/transfer/<int:transfer_id>/print")
@login_required
@require_permission("transfer", "view")
def transfer_print(transfer_id):
    transfer = db.session.get(InterCompanyTransfer, transfer_id)
    if not transfer:
        abort(404)
    require_active_company_document(transfer.from_company_id, transfer.to_company_id)
    return print_response(transfer_rows(transfer))


@bp.route("/opening", methods=["GET"])
@login_required
@require_permission("opening", "view")
def opening():
    company_id = active_company_id()
    opening_stock = OpeningStock.query.filter_by(is_void=False)
    receivables = Receivable.query.filter_by(is_opening=True)
    payables = Payable.query.filter_by(is_opening=True)
    advances = Payment.query.filter(Payment.payment_type.like("OPENING_ADVANCE%"))
    if company_id:
        opening_stock = opening_stock.filter(OpeningStock.company_id == company_id)
        receivables = receivables.filter(Receivable.company_id == company_id)
        payables = payables.filter(Payable.company_id == company_id)
        advances = advances.filter(Payment.company_id == company_id)
    return render_template(
        "transactions/opening.html",
        opening_stock=opening_stock.order_by(OpeningStock.opening_date.desc()).limit(20).all(),
        receivables=receivables.order_by(Receivable.document_date.desc()).limit(20).all(),
        payables=payables.order_by(Payable.document_date.desc()).limit(20).all(),
        advances=advances.order_by(Payment.payment_date.desc()).limit(20).all(),
        **options(),
    )


@bp.route("/opening/<section>", methods=["POST"])
@login_required
@require_permission("opening", "create")
def opening_save(section):
    try:
        if section == "stock":
            require_active_company_value(request.form.get("company_id"))
            record = create_opening_stock(request.form, item_lines_from_form(request.form), current_user)
            message = f"Opening stock {record.reference_number} saved."
        elif section == "receivable":
            require_active_company_value(request.form.get("company_id"))
            record = create_opening_receivable(request.form, current_user)
            message = f"Opening receivable {record.document_number} saved."
        elif section == "pending-stock":
            require_transfer_scope(request.form)
            record = create_opening_pending_stock(request.form, item_lines_from_form(request.form), current_user)
            message = f"Opening pending stock {record.reference_number} saved."
        elif section == "payable":
            require_active_company_value(request.form.get("company_id"))
            record = create_opening_payable(request.form, current_user)
            message = f"Opening payable {record.document_number} saved."
        elif section == "advance-received":
            require_active_company_value(request.form.get("company_id"))
            record = create_opening_advance_received(request.form, current_user)
            message = "Opening advance received saved."
        elif section == "advance-paid":
            require_active_company_value(request.form.get("company_id"))
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


@bp.route("/opening/stock/<int:opening_id>/delete", methods=["POST"])
@login_required
def opening_stock_delete(opening_id):
    if not (can(current_user, "opening", "create") or can(current_user, "opening", "deactivate")):
        abort(403)
    opening = db.session.get(OpeningStock, opening_id)
    if not opening:
        flash("Opening stock not found.", "danger")
        return redirect(url_for("transactions.opening"))
    require_active_company_document(opening.company_id)
    try:
        void_opening_stock(opening, current_user)
        db.session.commit()
        flash("Opening stock deleted and stock reversed.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("transactions.opening"))


@bp.route("/opening/stock/<int:opening_id>/export/<fmt>")
@login_required
@require_permission("opening", "view")
def opening_stock_export(opening_id, fmt):
    opening = db.session.get(OpeningStock, opening_id)
    if not opening:
        abort(404)
    require_active_company_document(opening.company_id)
    return export_response(opening_stock_rows(opening), fmt)


@bp.route("/opening/stock/<int:opening_id>/print")
@login_required
@require_permission("opening", "view")
def opening_stock_print(opening_id):
    opening = db.session.get(OpeningStock, opening_id)
    if not opening:
        abort(404)
    require_active_company_document(opening.company_id)
    return print_response(opening_stock_rows(opening))


@bp.route("/opening/stock/<int:opening_id>/edit", methods=["GET", "POST"])
@login_required
def opening_stock_edit(opening_id):
    if not (can(current_user, "opening", "edit") or can(current_user, "opening", "create")):
        abort(403)
    opening = db.session.get(OpeningStock, opening_id)
    if not opening:
        flash("Opening stock not found.", "danger")
        return redirect(url_for("transactions.opening"))
    require_active_company_document(opening.company_id)
    if request.method == "POST":
        try:
            require_active_company_value(request.form.get("company_id") or opening.company_id)
            update_opening_stock(opening, request.form, item_lines_from_form(request.form), current_user)
            db.session.commit()
            flash("Opening stock updated.", "success")
            return redirect(url_for("transactions.opening"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("transactions/opening_edit.html", section="stock", record=opening, **options(scope_to_active_company=True))


@bp.route("/opening/receivable/<int:receivable_id>/delete", methods=["POST"])
@login_required
def opening_receivable_delete(receivable_id):
    if not (can(current_user, "opening", "create") or can(current_user, "opening", "deactivate")):
        abort(403)
    receivable = db.session.get(Receivable, receivable_id)
    if not receivable:
        flash("Opening receivable not found.", "danger")
        return redirect(url_for("transactions.opening"))
    require_active_company_document(receivable.company_id)
    try:
        delete_opening_receivable(receivable, current_user)
        db.session.commit()
        flash("Opening receivable deleted.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("transactions.opening"))


@bp.route("/opening/receivable/<int:receivable_id>/export/<fmt>")
@login_required
@require_permission("opening", "view")
def opening_receivable_export(receivable_id, fmt):
    receivable = db.session.get(Receivable, receivable_id)
    if not receivable:
        abort(404)
    require_active_company_document(receivable.company_id)
    return export_response(receivable_rows(receivable), fmt)


@bp.route("/opening/receivable/<int:receivable_id>/print")
@login_required
@require_permission("opening", "view")
def opening_receivable_print(receivable_id):
    receivable = db.session.get(Receivable, receivable_id)
    if not receivable:
        abort(404)
    require_active_company_document(receivable.company_id)
    return print_response(receivable_rows(receivable))


@bp.route("/opening/receivable/<int:receivable_id>/edit", methods=["GET", "POST"])
@login_required
def opening_receivable_edit(receivable_id):
    if not (can(current_user, "opening", "edit") or can(current_user, "opening", "create")):
        abort(403)
    receivable = db.session.get(Receivable, receivable_id)
    if not receivable:
        flash("Opening receivable not found.", "danger")
        return redirect(url_for("transactions.opening"))
    require_active_company_document(receivable.company_id)
    if request.method == "POST":
        try:
            require_active_company_value(request.form.get("company_id") or receivable.company_id)
            update_opening_receivable(receivable, request.form, current_user)
            db.session.commit()
            flash("Opening receivable updated.", "success")
            return redirect(url_for("transactions.opening"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("transactions/opening_edit.html", section="receivable", record=receivable, **options(scope_to_active_company=True))


@bp.route("/opening/payable/<int:payable_id>/delete", methods=["POST"])
@login_required
def opening_payable_delete(payable_id):
    if not (can(current_user, "opening", "create") or can(current_user, "opening", "deactivate")):
        abort(403)
    payable = db.session.get(Payable, payable_id)
    if not payable:
        flash("Opening payable not found.", "danger")
        return redirect(url_for("transactions.opening"))
    require_active_company_document(payable.company_id)
    try:
        delete_opening_payable(payable, current_user)
        db.session.commit()
        flash("Opening payable deleted.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("transactions.opening"))


@bp.route("/opening/payable/<int:payable_id>/export/<fmt>")
@login_required
@require_permission("opening", "view")
def opening_payable_export(payable_id, fmt):
    payable = db.session.get(Payable, payable_id)
    if not payable:
        abort(404)
    require_active_company_document(payable.company_id)
    return export_response(payable_rows(payable), fmt)


@bp.route("/opening/payable/<int:payable_id>/print")
@login_required
@require_permission("opening", "view")
def opening_payable_print(payable_id):
    payable = db.session.get(Payable, payable_id)
    if not payable:
        abort(404)
    require_active_company_document(payable.company_id)
    return print_response(payable_rows(payable))


@bp.route("/opening/payable/<int:payable_id>/edit", methods=["GET", "POST"])
@login_required
def opening_payable_edit(payable_id):
    if not (can(current_user, "opening", "edit") or can(current_user, "opening", "create")):
        abort(403)
    payable = db.session.get(Payable, payable_id)
    if not payable:
        flash("Opening payable not found.", "danger")
        return redirect(url_for("transactions.opening"))
    require_active_company_document(payable.company_id)
    if request.method == "POST":
        try:
            require_active_company_value(request.form.get("company_id") or payable.company_id)
            update_opening_payable(payable, request.form, current_user)
            db.session.commit()
            flash("Opening payable updated.", "success")
            return redirect(url_for("transactions.opening"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("transactions/opening_edit.html", section="payable", record=payable, **options(scope_to_active_company=True))


@bp.route("/opening/advance/<int:payment_id>/delete", methods=["POST"])
@login_required
def opening_advance_delete(payment_id):
    if not (can(current_user, "opening", "create") or can(current_user, "opening", "deactivate")):
        abort(403)
    payment = db.session.get(Payment, payment_id)
    if not payment:
        flash("Opening advance not found.", "danger")
        return redirect(url_for("transactions.opening"))
    require_active_company_document(payment.company_id)
    try:
        delete_opening_advance(payment, current_user)
        db.session.commit()
        flash("Opening advance deleted.", "success")
    except Exception as exc:
        db.session.rollback()
        flash(str(exc), "danger")
    return redirect(url_for("transactions.opening"))


@bp.route("/opening/advance/<int:payment_id>/export/<fmt>")
@login_required
@require_permission("opening", "view")
def opening_advance_export(payment_id, fmt):
    payment = db.session.get(Payment, payment_id)
    if not payment:
        abort(404)
    require_active_company_document(payment.company_id)
    return export_response(payment_rows(payment), fmt)


@bp.route("/opening/advance/<int:payment_id>/print")
@login_required
@require_permission("opening", "view")
def opening_advance_print(payment_id):
    payment = db.session.get(Payment, payment_id)
    if not payment:
        abort(404)
    require_active_company_document(payment.company_id)
    return print_response(payment_rows(payment))


@bp.route("/opening/advance/<int:payment_id>/edit", methods=["GET", "POST"])
@login_required
def opening_advance_edit(payment_id):
    if not (can(current_user, "opening", "edit") or can(current_user, "opening", "create")):
        abort(403)
    payment = db.session.get(Payment, payment_id)
    if not payment:
        flash("Opening advance not found.", "danger")
        return redirect(url_for("transactions.opening"))
    require_active_company_document(payment.company_id)
    if request.method == "POST":
        try:
            require_active_company_value(request.form.get("company_id") or payment.company_id)
            update_opening_advance(payment, request.form, current_user)
            db.session.commit()
            flash("Opening advance updated.", "success")
            return redirect(url_for("transactions.opening"))
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("transactions/opening_edit.html", section="advance", record=payment, **options(scope_to_active_company=True))
