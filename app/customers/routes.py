from flask import Blueprint, abort, jsonify, request, url_for
from flask_login import login_required

from app.core.company_context import active_company
from app.core.formatting import fmt_money, fmt_qty
from app.core.periods import period_from_args
from app.core.security import require_permission
from app.services.customer_profile import customer_master_rows, customer_profile

bp = Blueprint("customers_api", __name__, url_prefix="/customers")


def requested_company_id():
    company = active_company()
    if company:
        return company.id
    value = request.args.get("company_id")
    try:
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def customer_json(customer):
    return {
        "id": customer.id,
        "code": customer.code,
        "customer_name": customer.name,
        "contact_person": customer.contact_person,
        "mobile": customer.mobile,
        "whatsapp": customer.whatsapp,
        "email": customer.email,
        "gst_number": customer.gst_number,
        "address": customer.address,
        "city": customer.city,
        "state": customer.state,
        "notes": customer.notes,
        "active": customer.active,
        "created_at": customer.created_at.isoformat() if customer.created_at else None,
        "updated_at": customer.updated_at.isoformat() if customer.updated_at else None,
    }


def profile_or_404(customer_id):
    date_from, date_to = period_from_args(request.args)
    profile = customer_profile(customer_id, requested_company_id(), date_from, date_to)
    if not profile:
        abort(404)
    return profile


def invoice_json(sale):
    return {
        "id": sale.id,
        "company_id": sale.company_id,
        "company": sale.company.code,
        "invoice_number": sale.invoice_number,
        "invoice_date": str(sale.invoice_date),
        "due_date": str(sale.due_date or ""),
        "sale_type": sale.sale_type,
        "total": fmt_money(sale.grand_total),
        "paid": fmt_money(sale.paid_amount),
        "pending": fmt_money(sale.balance_amount),
        "status": sale.payment_status,
        "edit_url": url_for("transactions.sale_edit", sale_id=sale.id),
        "pdf_url": url_for("transactions.sale_export", sale_id=sale.id, fmt="pdf"),
    }


def challan_json(row):
    return {
        "challan_number": row["challan_number"],
        "challan_date": str(row["challan_date"]),
        "item_name": row["item"],
        "quantity": fmt_qty(row["quantity"]),
        "weight": row["weight"],
        "status": row["status"],
        "pdf_url": url_for("transactions.sale_export", sale_id=row["sale"].id, fmt="pdf"),
    }


def payment_json(payment):
    return {
        "id": payment.id,
        "company_id": payment.company_id,
        "company": payment.company.code,
        "payment_date": str(payment.payment_date),
        "payment_mode": payment.mode,
        "amount": fmt_money(payment.total_amount),
        "allocated": fmt_money(payment.allocated_amount),
        "pending": fmt_money(payment.unallocated_amount),
        "reference_number": payment.reference_number,
        "remarks": payment.remarks,
    }


def document_json(document):
    return {
        "label": document["label"],
        "type": document["type"],
        "date": str(document["date"]),
        "sale_id": document["sale"].id,
        "url": url_for("transactions.sale_export", sale_id=document["sale"].id, fmt="pdf"),
    }


@bp.route("")
@login_required
@require_permission("customers", "view")
def list_customers():
    rows = customer_master_rows(
        search=request.args.get("q"),
        company_id=requested_company_id(),
        active_filter=request.args.get("active", "active"),
    )
    return jsonify(
        {
            "customers": [
                {
                    **customer_json(row["customer"]),
                    "companies": [{"id": company.id, "code": company.code, "name": company.name} for company in row["companies"]],
                    "display": row["identity"],
                }
                for row in rows
            ]
        }
    )


@bp.route("/<int:customer_id>")
@login_required
@require_permission("customers", "view")
def detail(customer_id):
    profile = profile_or_404(customer_id)
    customer = profile["customer"]
    return jsonify(
        {
            "customer": customer_json(customer),
            "companies": [{"id": company.id, "code": company.code, "name": company.name} for company in profile["companies"]],
            "summary": {
                "total_invoices": profile["summary"]["total_invoices"],
                "total_sales": fmt_money(profile["summary"]["total_sales"]),
                "total_received": fmt_money(profile["summary"]["total_received"]),
                "total_pending": fmt_money(profile["summary"]["total_pending"]),
                "last_transaction_date": str(profile["summary"]["last_transaction"] or ""),
                "last_payment_date": str(profile["summary"]["last_payment"] or ""),
                "stock_given": fmt_qty(profile["summary"]["stock_given"]),
                "stock_received_back": fmt_qty(profile["summary"]["stock_received"]),
                "pending_stock": fmt_qty(profile["summary"]["pending_stock"]),
            },
            "invoices": [invoice_json(sale) for sale in profile["invoices"]],
            "challans": [challan_json(row) for row in profile["stock_rows"]],
            "stock": {
                "summary": {
                    "stock_given": fmt_qty(profile["summary"]["stock_given"]),
                    "stock_received_back": fmt_qty(profile["summary"]["stock_received"]),
                    "pending_stock": fmt_qty(profile["summary"]["pending_stock"]),
                },
                "rows": [challan_json(row) for row in profile["stock_rows"]],
            },
            "payments": [payment_json(payment) for payment in profile["payments"]],
            "documents": [document_json(document) for document in profile["documents"]],
        }
    )


@bp.route("/<int:customer_id>/invoices")
@login_required
@require_permission("customers", "view")
def invoices(customer_id):
    profile = profile_or_404(customer_id)
    return jsonify({"invoices": [invoice_json(sale) for sale in profile["invoices"]]})


@bp.route("/<int:customer_id>/challans")
@login_required
@require_permission("customers", "view")
def challans(customer_id):
    profile = profile_or_404(customer_id)
    return jsonify({"challans": [challan_json(row) for row in profile["stock_rows"]]})


@bp.route("/<int:customer_id>/payments")
@login_required
@require_permission("customers", "view")
def payments(customer_id):
    profile = profile_or_404(customer_id)
    return jsonify({"payments": [payment_json(payment) for payment in profile["payments"]]})


@bp.route("/<int:customer_id>/stock")
@login_required
@require_permission("customers", "view")
def stock(customer_id):
    profile = profile_or_404(customer_id)
    return jsonify(
        {
            "summary": {
                "stock_given": fmt_qty(profile["summary"]["stock_given"]),
                "stock_received_back": fmt_qty(profile["summary"]["stock_received"]),
                "pending_stock": fmt_qty(profile["summary"]["pending_stock"]),
            },
            "stock": [challan_json(row) for row in profile["stock_rows"]],
        }
    )
