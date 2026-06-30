from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app.core.company_context import active_company
from app.core.formatting import dec, fmt_money, fmt_qty, qty
from app.core.periods import period_from_args
from app.core.security import require_permission
from app.extensions import db
from app.models import Company, Customer, Item, Payment, Receivable, Sale, StockBook, Supplier
from app.reports.exporting import export_table
from app.services.customer_statement import (
    customer_statement_context,
    customer_statement_export_headers,
    customer_statement_export_rows,
    export_customer_statement_pdf,
)
from app.services.audit import audit
from app.services.customer_profile import customer_master_rows, customer_profile, paginate_rows
from app.services.supplier_profile import supplier_transactions

bp = Blueprint("masters", __name__, url_prefix="/masters")


MASTER_CONFIG = {
    "items": {
        "model": Item,
        "module": "items",
        "title": "Items",
        "description": "Maintain item codes, GST rates, units, and minimum stock levels.",
        "columns": ["code", "name", "unit", "hsn", "gst_percent", "minimum_stock", "active"],
    },
    "customers": {
        "model": Customer,
        "module": "customers",
        "title": "Customers",
        "description": "Maintain customer GST/cash classification and credit defaults.",
        "columns": ["code", "name", "customer_type", "gst_number", "mobile", "default_credit_days", "active"],
    },
    "suppliers": {
        "model": Supplier,
        "module": "suppliers",
        "title": "Suppliers",
        "description": "Maintain supplier contact details and default credit days.",
        "columns": ["code", "name", "gst_number", "mobile", "default_credit_days", "active"],
    },
    "companies": {
        "model": Company,
        "module": "companies",
        "title": "Companies",
        "description": "Company transaction rules for FML and AI.",
        "columns": [
            "code",
            "name",
            "gst_number",
            "allow_gst_purchase",
            "allow_cash_purchase",
            "allow_gst_sale",
            "allow_cash_sale",
            "active",
        ],
    },
    "stock-books": {
        "model": StockBook,
        "module": "stock_books",
        "title": "Stock Books",
        "description": "Segregated GST and cash stock pools by company.",
        "columns": ["code", "name", "company", "book_type", "active"],
    },
}


def config_or_404(kind):
    config = MASTER_CONFIG.get(kind)
    if not config:
        from flask import abort

        abort(404)
    return config


@bp.route("/")
@login_required
def index():
    return redirect(url_for("masters.list_records", kind="items"))


@bp.route("/<kind>")
@login_required
def list_records(kind):
    config = config_or_404(kind)
    require_permission(config["module"], "view")(lambda: None)()
    if kind == "customers":
        return list_customers(config)
    model = config["model"]
    query = model.query
    active_filter = request.args.get("active", "active")
    search = (request.args.get("q") or "").strip()
    if active_filter == "active" and hasattr(model, "active"):
        query = query.filter_by(active=True)
    elif active_filter == "inactive" and hasattr(model, "active"):
        query = query.filter_by(active=False)
    if search:
        normalized = search.lower()
        conditions = []
        if hasattr(model, "code"):
            conditions.append(func.lower(func.coalesce(model.code, "")).like(f"%{normalized}%"))
        if hasattr(model, "name"):
            conditions.append(func.lower(func.coalesce(model.name, "")).like(f"%{normalized}%"))
        if conditions:
            query = query.filter(db.or_(*conditions))
    records = query.order_by(getattr(model, "code", getattr(model, "id"))).all()
    return render_template("masters/list.html", kind=kind, config=config, records=records)


def selected_customer_company_id():
    company = active_company()
    if company:
        return company.id
    value = request.args.get("company_id")
    try:
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def list_customers(config):
    selected_company_id = selected_customer_company_id()
    rows = customer_master_rows(
        search=request.args.get("q"),
        company_id=selected_company_id,
        active_filter=request.args.get("active", "active"),
        include_suppliers=True,
    )
    page = request.args.get("page", 1)
    pagination = paginate_rows(rows, page, 25)
    companies = Company.query.filter_by(active=True).order_by(Company.code).all()
    return render_template(
        "masters/customer_list.html",
        kind="customers",
        config=config,
        rows=pagination["items"],
        pagination=pagination,
        all_rows=rows,
        companies=companies,
        selected_company_id=selected_company_id,
    )


@bp.route("/customers/<int:customer_id>")
@login_required
def customer_detail(customer_id):
    config = config_or_404("customers")
    require_permission(config["module"], "view")(lambda: None)()
    selected_company_id = selected_customer_company_id()
    date_from, date_to = period_from_args(request.args)
    profile = customer_profile(customer_id, selected_company_id, date_from, date_to)
    if not profile:
        abort(404)
    companies = Company.query.filter_by(active=True).order_by(Company.code).all()
    return render_template(
        "masters/customer_detail.html",
        profile=profile,
        companies=companies,
        selected_company_id=selected_company_id,
        date_from=date_from,
        date_to=date_to,
    )


@bp.route("/customers/<int:customer_id>/print")
@login_required
def customer_print(customer_id):
    config = config_or_404("customers")
    require_permission(config["module"], "view")(lambda: None)()
    selected_company_id = selected_customer_company_id()
    date_from, date_to = period_from_args(request.args)
    profile = customer_profile(customer_id, selected_company_id, date_from, date_to)
    if not profile:
        abort(404)
    selected_company = db.session.get(Company, selected_company_id) if selected_company_id else None
    statement = customer_statement_context(profile, selected_company, selected_company_id, date_from, date_to)
    return render_template(
        "masters/customer_print.html",
        profile=profile,
        statement=statement,
        selected_company=selected_company,
        selected_company_id=selected_company_id,
        date_from=date_from,
        date_to=date_to,
    )


@bp.route("/customers/<int:customer_id>/export/<fmt>")
@login_required
def customer_export(customer_id, fmt):
    config = config_or_404("customers")
    require_permission(config["module"], "view")(lambda: None)()
    selected_company_id = selected_customer_company_id()
    date_from, date_to = period_from_args(request.args)
    profile = customer_profile(customer_id, selected_company_id, date_from, date_to)
    if not profile:
        abort(404)
    selected_company = db.session.get(Company, selected_company_id) if selected_company_id else None
    statement = customer_statement_context(profile, selected_company, selected_company_id, date_from, date_to)
    if (fmt or "").lower() == "pdf":
        return export_customer_statement_pdf(statement)
    try:
        return export_table(
            f"Customer Overall - {profile['customer'].name}",
            customer_statement_export_headers(),
            customer_statement_export_rows(statement),
            fmt,
        )
    except ValueError:
        abort(404)


@bp.route("/suppliers/<int:supplier_id>/transactions")
@login_required
def supplier_transaction_detail(supplier_id):
    config = config_or_404("suppliers")
    require_permission(config["module"], "view")(lambda: None)()
    selected_company_id = selected_customer_company_id()
    date_from, date_to = period_from_args(request.args)
    profile = supplier_transactions(supplier_id, selected_company_id, date_from, date_to)
    if not profile:
        abort(404)
    companies = Company.query.filter_by(active=True).order_by(Company.code).all()
    return render_template(
        "masters/supplier_transactions.html",
        profile=profile,
        companies=companies,
        selected_company_id=selected_company_id,
        date_from=date_from,
        date_to=date_to,
    )


@bp.route("/<kind>/new", methods=["GET", "POST"])
@login_required
def create_record(kind):
    config = config_or_404(kind)
    require_permission(config["module"], "create")(lambda: None)()
    record = config["model"]()
    if request.method == "POST":
        try:
            apply_form(record, kind)
            ensure_unique_code(record, kind)
            ensure_unique_customer_name(record, kind)
            record.created_by_id = current_user.id
            db.session.add(record)
            db.session.flush()
            audit("create", config["title"], record.id, getattr(record, "code", None), user=current_user)
            db.session.commit()
            flash(f"{config['title'][:-1]} saved.", "success")
            return redirect(url_for("masters.list_records", kind=kind))
        except IntegrityError as exc:
            db.session.rollback()
            flash(friendly_integrity_error(kind, exc), "danger")
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("masters/form.html", kind=kind, config=config, record=record, companies=Company.query.filter_by(active=True).all())


@bp.route("/<kind>/<int:record_id>/edit", methods=["GET", "POST"])
@login_required
def edit_record(kind, record_id):
    config = config_or_404(kind)
    require_permission(config["module"], "edit")(lambda: None)()
    record = db.session.get(config["model"], record_id)
    if not record:
        flash("Record not found.", "danger")
        return redirect(url_for("masters.list_records", kind=kind))
    if request.method == "POST":
        try:
            before = snapshot(record)
            apply_form(record, kind)
            ensure_unique_code(record, kind)
            ensure_unique_customer_name(record, kind)
            record.updated_by_id = current_user.id
            audit("edit", config["title"], record.id, getattr(record, "code", None), before=before, after=snapshot(record), user=current_user)
            db.session.commit()
            flash(f"{config['title'][:-1]} updated.", "success")
            return redirect(url_for("masters.list_records", kind=kind))
        except IntegrityError as exc:
            db.session.rollback()
            flash(friendly_integrity_error(kind, exc), "danger")
        except Exception as exc:
            db.session.rollback()
            flash(str(exc), "danger")
    return render_template("masters/form.html", kind=kind, config=config, record=record, companies=Company.query.filter_by(active=True).all())


@bp.route("/customers/<int:customer_id>/delete", methods=["POST"])
@login_required
def delete_customer(customer_id):
    config = config_or_404("customers")
    require_permission(config["module"], "deactivate")(lambda: None)()
    customer = db.session.get(Customer, customer_id)
    if not customer:
        flash("Customer not found.", "danger")
        return redirect(url_for("masters.list_records", kind="customers"))
    if customer_has_transactions(customer.id):
        customer.active = False
        customer.updated_by_id = current_user.id
        audit("deactivate", config["title"], customer.id, customer.code, user=current_user)
        db.session.commit()
        flash("Customer has transactions, so it was deactivated instead of permanently deleted.", "warning")
        return redirect(url_for("masters.list_records", kind="customers"))
    before = snapshot(customer)
    reference = customer.code
    db.session.delete(customer)
    audit("delete", config["title"], customer_id, reference, before=before, user=current_user)
    db.session.commit()
    flash("Customer deleted.", "success")
    return redirect(url_for("masters.list_records", kind="customers"))


@bp.route("/<kind>/<int:record_id>/deactivate", methods=["POST"])
@login_required
def deactivate_record(kind, record_id):
    config = config_or_404(kind)
    require_permission(config["module"], "deactivate")(lambda: None)()
    record = db.session.get(config["model"], record_id)
    if not record:
        flash("Record not found.", "danger")
        return redirect(url_for("masters.list_records", kind=kind))
    if hasattr(record, "active"):
        record.active = False
        record.updated_by_id = current_user.id if hasattr(record, "updated_by_id") else None
        audit("deactivate", config["title"], record.id, getattr(record, "code", None), user=current_user)
        db.session.commit()
        flash("Record deactivated. Historical references remain intact.", "success")
    return redirect(url_for("masters.list_records", kind=kind))


def snapshot(record):
    values = {}
    for column in record.__table__.columns:
        values[column.name] = getattr(record, column.name)
    return values


def singular_title(kind):
    config = MASTER_CONFIG[kind]
    return config["title"][:-1] if config["title"].endswith("s") else config["title"]


def ensure_unique_code(record, kind):
    if not getattr(record, "code", None):
        return
    model = MASTER_CONFIG[kind]["model"]
    code = record.code.strip().lower()
    query = model.query.filter(func.lower(func.trim(model.code)) == code)
    if getattr(record, "id", None):
        query = query.filter(model.id != record.id)
    if query.first():
        raise ValueError(f"{singular_title(kind)} code '{record.code}' already exists. Use a different code or edit the existing record.")


def ensure_unique_customer_name(record, kind):
    if kind != "customers" or not getattr(record, "name", None):
        return
    name = record.name.strip().lower()
    query = Customer.query.filter(func.lower(func.trim(Customer.name)) == name)
    if getattr(record, "id", None):
        query = query.filter(Customer.id != record.id)
    duplicate = query.first()
    if duplicate:
        raise ValueError(
            f"Customer '{record.name}' already exists as code {duplicate.code}. "
            "Open the existing customer instead of creating a duplicate."
        )


def customer_has_transactions(customer_id):
    checks = (
        Sale.query.filter(Sale.customer_id == customer_id, Sale.is_void.is_(False)).with_entities(Sale.id),
        Receivable.query.filter(Receivable.customer_id == customer_id).with_entities(Receivable.id),
        Payment.query.filter(Payment.customer_id == customer_id).with_entities(Payment.id),
    )
    return any(query.first() for query in checks)


CUSTOMER_EXPORT_HEADERS = ["Section", "Date / Field", "Document", "Type", "Total / Debit", "Paid / Credit", "Balance / Status", "Details"]


def customer_export_rows(profile, date_from, date_to):
    customer = profile["customer"]
    summary = profile["summary"]
    companies = ", ".join(company.code for company in profile["companies"]) or "All"
    rows = [
        ["Summary", "Period", "", "", date_from, date_to, "", f"Companies: {companies}"],
        ["Summary", "Total Sales", "", "", fmt_money(summary["total_sales"]), "", "", f"{summary['total_invoices']} invoice(s)"],
        ["Summary", "Received", "", "", fmt_money(summary["total_received"]), "", "", f"Last payment: {summary['last_payment'] or '-'}"],
        ["Summary", "Pending Payment", "", "", fmt_money(summary["total_pending"]), "", "", f"Last transaction: {summary['last_transaction'] or '-'}"],
        ["Summary", "Pending Stock", "", "", fmt_qty(summary["pending_stock"]), "", "", ""],
        ["Customer", "Code", "", "", customer.code, "", "", ""],
        ["Customer", "Name", "", "", customer.name, "", "", ""],
        ["Customer", "Contact", "", "", customer.contact_person or "", customer.mobile or "", customer.whatsapp or "", ""],
        ["Customer", "Email / GST", "", "", customer.email or "", customer.gst_number or "", "", ""],
        ["Customer", "City / State", "", "", customer.city or "", customer.state or "", "", customer.address or ""],
        ["Customer", "Notes", "", "", customer.notes or "", "", "", ""],
    ]
    for sale in profile["invoices"]:
        rows.append(
            [
                "Invoice",
                sale.invoice_date,
                sale.invoice_number,
                sale.sale_type,
                fmt_money(sale.grand_total),
                fmt_money(sale.paid_amount),
                f"{fmt_money(sale.balance_amount)} / {sale.payment_status}",
                sale.remarks or "",
            ]
        )
    for receivable in profile["receivables"]:
        rows.append(
            [
                "Outstanding",
                receivable.document_date,
                receivable.document_number,
                receivable.source_type,
                fmt_money(receivable.total_amount),
                fmt_money(receivable.paid_amount),
                f"{fmt_money(receivable.balance_amount)} / {receivable.payment_status}",
                f"Due: {receivable.due_date or ''}",
            ]
        )
    for stock_row in profile["stock_rows"]:
        rows.append(
            [
                "Stock / Challan",
                stock_row["challan_date"],
                stock_row["challan_number"],
                stock_row["item"],
                fmt_qty(stock_row["quantity"]),
                "",
                stock_row["status"],
                stock_row["weight"],
            ]
        )
    for payment in profile["payments"]:
        rows.append(
            [
                "Payment",
                payment.payment_date,
                payment.reference_number or "",
                payment.mode,
                fmt_money(payment.total_amount),
                fmt_money(payment.allocated_amount),
                fmt_money(payment.unallocated_amount),
                payment.remarks or "",
            ]
        )
    for document in profile["documents"]:
        rows.append(["Document", document["date"], document["label"], document["type"], "", "", "", ""])
    return rows


def friendly_integrity_error(kind, exc):
    message = str(getattr(exc, "orig", exc))
    if "Duplicate entry" in message or "UNIQUE constraint failed" in message:
        code = (request.form.get("code") or "").strip()
        detail = f" code '{code}'" if code else ""
        return f"{singular_title(kind)}{detail} already exists. Use a different code or edit the existing record."
    return "This record could not be saved because it conflicts with existing data."


def apply_form(record, kind):
    form = request.form
    if kind == "items":
        record.code = form["code"].strip()
        record.name = form["name"].strip()
        record.unit = form.get("unit", "pcs").strip() or "pcs"
        record.hsn = form.get("hsn") or None
        record.gst_percent = dec(form.get("gst_percent") or "0")
        record.minimum_stock = qty(form.get("minimum_stock") or "0")
        record.notes = form.get("notes") or None
        record.active = bool(form.get("active"))
    elif kind == "customers":
        record.code = form["code"].strip()
        record.name = form["name"].strip()
        record.contact_person = form.get("contact_person") or None
        customer_type = form.get("customer_type") or "CASH_AND_BILL"
        if customer_type not in {"CASH", "BILL", "CASH_AND_BILL"}:
            raise ValueError("Customer type must be CASH, BILL, or CASH_AND_BILL.")
        record.customer_type = customer_type
        record.gst_number = form.get("gst_number") or None
        record.mobile = form.get("mobile") or None
        record.whatsapp = form.get("whatsapp") or None
        record.email = form.get("email") or None
        record.address = form.get("address") or None
        record.city = form.get("city") or None
        record.state = form.get("state") or None
        record.default_credit_days = int(form.get("default_credit_days") or 0)
        record.notes = form.get("notes") or None
        record.active = bool(form.get("active"))
    elif kind == "suppliers":
        record.code = form["code"].strip()
        record.name = form["name"].strip()
        record.gst_number = form.get("gst_number") or None
        record.mobile = form.get("mobile") or None
        record.email = form.get("email") or None
        record.address = form.get("address") or None
        record.default_credit_days = int(form.get("default_credit_days") or 0)
        record.active = bool(form.get("active"))
    elif kind == "companies":
        record.code = form["code"].strip()
        record.name = form["name"].strip()
        record.gst_number = form.get("gst_number") or None
        record.allow_gst_purchase = bool(form.get("allow_gst_purchase"))
        record.allow_cash_purchase = bool(form.get("allow_cash_purchase"))
        record.allow_gst_sale = bool(form.get("allow_gst_sale"))
        record.allow_cash_sale = bool(form.get("allow_cash_sale"))
        record.active = bool(form.get("active"))
    elif kind == "stock-books":
        record.company_id = int(form["company_id"])
        record.code = form["code"].strip()
        record.name = form["name"].strip()
        record.book_type = form.get("book_type") or "GST"
        record.active = bool(form.get("active"))
    if not getattr(record, "code", None) or not getattr(record, "name", None):
        raise ValueError("Code and name are required.")
