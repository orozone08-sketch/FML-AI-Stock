from flask import Blueprint, abort, flash, redirect, render_template, request, url_for
from flask_login import current_user, login_required
from sqlalchemy.exc import IntegrityError

from app.core.company_context import active_company
from app.core.formatting import dec, qty
from app.core.security import require_permission
from app.extensions import db
from app.models import Company, Customer, Item, StockBook, Supplier
from app.services.audit import audit
from app.services.customer_profile import customer_master_rows, customer_profile, paginate_rows

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
        if hasattr(model, "name"):
            query = query.filter(model.name.ilike(f"%{search}%"))
        elif hasattr(model, "code"):
            query = query.filter(model.code.ilike(f"%{search}%"))
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
    profile = customer_profile(customer_id, selected_company_id)
    if not profile:
        abort(404)
    companies = Company.query.filter_by(active=True).order_by(Company.code).all()
    return render_template(
        "masters/customer_detail.html",
        profile=profile,
        companies=companies,
        selected_company_id=selected_company_id,
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
    query = model.query.filter(model.code == record.code)
    if getattr(record, "id", None):
        query = query.filter(model.id != record.id)
    if query.first():
        raise ValueError(f"{singular_title(kind)} code '{record.code}' already exists. Use a different code or edit the existing record.")


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
