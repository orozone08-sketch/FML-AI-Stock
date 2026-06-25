from collections import defaultdict
from decimal import Decimal

from app.core.formatting import money, qty
from app.extensions import db
from app.models import Company, Customer, Payable, Payment, Purchase, Receivable, Sale, SaleLine, Supplier


def selected_company_ids_for_customer(customer_id):
    company_ids = set()
    for model, column in (
        (Sale, Sale.company_id),
        (Receivable, Receivable.company_id),
        (Payment, Payment.company_id),
    ):
        query = db.session.query(column).filter(model.customer_id == customer_id)
        if hasattr(model, "is_void"):
            query = query.filter(model.is_void.is_(False))
        company_ids.update(row[0] for row in query.distinct().all())
    return company_ids


def customer_company_map():
    mapping = defaultdict(set)
    for customer_id, company_id in db.session.query(Sale.customer_id, Sale.company_id).filter(Sale.is_void.is_(False)).all():
        mapping[customer_id].add(company_id)
    for customer_id, company_id in db.session.query(Receivable.customer_id, Receivable.company_id).filter(Receivable.customer_id.isnot(None)).all():
        mapping[customer_id].add(company_id)
    for customer_id, company_id in db.session.query(Payment.customer_id, Payment.company_id).filter(Payment.customer_id.isnot(None)).all():
        mapping[customer_id].add(company_id)
    return mapping


def supplier_company_map():
    mapping = defaultdict(set)
    for supplier_id, company_id in db.session.query(Purchase.supplier_id, Purchase.company_id).filter(Purchase.is_void.is_(False)).all():
        mapping[supplier_id].add(company_id)
    for supplier_id, company_id in db.session.query(Payable.supplier_id, Payable.company_id).filter(Payable.supplier_id.isnot(None)).all():
        mapping[supplier_id].add(company_id)
    for supplier_id, company_id in db.session.query(Payment.supplier_id, Payment.company_id).filter(Payment.supplier_id.isnot(None)).all():
        mapping[supplier_id].add(company_id)
    return mapping


def company_lookup():
    return {company.id: company for company in Company.query.order_by(Company.code).all()}


def customer_identity(customer):
    parts = [customer.code, customer.name]
    extras = [customer.mobile, customer.city, customer.gst_number]
    extra = next((value for value in extras if value), "")
    if extra:
        parts.append(str(extra))
    return " - ".join(parts[:2]) + (f" · {extra}" if extra else "")


def supplier_identity(supplier):
    parts = [supplier.code, supplier.name]
    extras = [supplier.mobile, supplier.gst_number]
    extra = next((value for value in extras if value), "")
    return " - ".join(parts[:2]) + (f" · {extra}" if extra else "")


def customer_search_text(customer, companies):
    fields = [
        customer.code,
        customer.name,
        customer.contact_person,
        customer.mobile,
        customer.whatsapp,
        customer.email,
        customer.gst_number,
        customer.address,
        customer.city,
        customer.state,
        customer.notes,
    ]
    for company in companies:
        fields.extend([company.code, company.name])
    return " ".join(str(field or "") for field in fields).lower()


def supplier_search_text(supplier, companies):
    fields = [
        supplier.code,
        supplier.name,
        supplier.mobile,
        supplier.email,
        supplier.gst_number,
        supplier.address,
        "supplier",
        "purchase",
    ]
    for company in companies:
        fields.extend([company.code, company.name])
    return " ".join(str(field or "") for field in fields).lower()


def row_companies_for_party(linked_company_ids, companies, company_id=None):
    if company_id and linked_company_ids and int(company_id) not in linked_company_ids:
        return None
    row_company_ids = linked_company_ids or ({int(company_id)} if company_id else set())
    return [companies[linked_id] for linked_id in sorted(row_company_ids) if linked_id in companies]


def customer_master_rows(search="", company_id=None, active_filter="active", include_suppliers=False):
    query = Customer.query
    if active_filter == "active":
        query = query.filter(Customer.active.is_(True))
    elif active_filter == "inactive":
        query = query.filter(Customer.active.is_(False))
    customers = query.order_by(Customer.name, Customer.code).all()
    company_map = customer_company_map()
    companies = company_lookup()
    search = (search or "").strip().lower()
    rows = []
    for customer in customers:
        linked_company_ids = company_map.get(customer.id, set())
        row_companies = row_companies_for_party(linked_company_ids, companies, company_id)
        if row_companies is None:
            continue
        if search and search not in customer_search_text(customer, row_companies):
            continue
        rows.append(
            {
                "kind": "customer",
                "customer": customer,
                "supplier": None,
                "identity": customer_identity(customer),
                "companies": row_companies,
                "company_label": ", ".join(company.code for company in row_companies) or "All",
            }
        )
    if include_suppliers:
        supplier_query = Supplier.query
        if active_filter == "active":
            supplier_query = supplier_query.filter(Supplier.active.is_(True))
        elif active_filter == "inactive":
            supplier_query = supplier_query.filter(Supplier.active.is_(False))
        supplier_map = supplier_company_map()
        for supplier in supplier_query.order_by(Supplier.name, Supplier.code).all():
            linked_company_ids = supplier_map.get(supplier.id, set())
            if not linked_company_ids:
                continue
            row_companies = row_companies_for_party(linked_company_ids, companies, company_id)
            if row_companies is None:
                continue
            if search and search not in supplier_search_text(supplier, row_companies):
                continue
            rows.append(
                {
                    "kind": "supplier",
                    "customer": None,
                    "supplier": supplier,
                    "identity": supplier_identity(supplier),
                    "companies": row_companies,
                    "company_label": ", ".join(company.code for company in row_companies) or "All",
                }
            )
    rows.sort(key=lambda row: (row["identity"].lower(), row["kind"]))
    return rows


def paginate_rows(rows, page, per_page):
    total = len(rows)
    page = max(int(page or 1), 1)
    per_page = max(min(int(per_page or 25), 100), 1)
    start = (page - 1) * per_page
    return {
        "items": rows[start : start + per_page],
        "page": page,
        "per_page": per_page,
        "total": total,
        "pages": max((total + per_page - 1) // per_page, 1),
    }


def customer_invoices(customer_id, company_id=None):
    query = Sale.query.filter_by(customer_id=customer_id, is_void=False)
    if company_id:
        query = query.filter(Sale.company_id == company_id)
    return query.order_by(Sale.invoice_date.desc(), Sale.id.desc()).all()


def customer_receivables(customer_id, company_id=None):
    query = Receivable.query.filter_by(customer_id=customer_id)
    if company_id:
        query = query.filter(Receivable.company_id == company_id)
    return query.order_by(Receivable.document_date.desc(), Receivable.id.desc()).all()


def customer_payments(customer_id, company_id=None):
    query = Payment.query.filter_by(customer_id=customer_id)
    if company_id:
        query = query.filter(Payment.company_id == company_id)
    return query.order_by(Payment.payment_date.desc(), Payment.id.desc()).all()


def customer_stock_rows(customer_id, company_id=None):
    query = SaleLine.query.join(Sale).filter(Sale.customer_id == customer_id, Sale.is_void.is_(False))
    if company_id:
        query = query.filter(Sale.company_id == company_id)
    rows = []
    for line in query.order_by(Sale.invoice_date.desc(), Sale.id.desc(), SaleLine.id).all():
        rows.append(
            {
                "challan_number": line.sale.invoice_number,
                "challan_date": line.sale.invoice_date,
                "item": line.item.display_name,
                "quantity": qty(line.quantity),
                "weight": f"{line.quantity} {line.item.unit}",
                "status": "Completed" if line.sale.payment_status == "PAID" else "Pending",
                "sale": line.sale,
            }
        )
    return rows


def customer_documents(invoices):
    return [
        {
            "label": f"Invoice PDF - {invoice.invoice_number}",
            "type": "Invoice PDF",
            "sale": invoice,
            "date": invoice.invoice_date,
        }
        for invoice in invoices
    ]


def customer_profile(customer_id, company_id=None):
    customer = db.session.get(Customer, customer_id)
    if not customer:
        return None
    invoices = customer_invoices(customer_id, company_id)
    receivables = customer_receivables(customer_id, company_id)
    payments = customer_payments(customer_id, company_id)
    stock_rows = customer_stock_rows(customer_id, company_id)
    companies_by_id = company_lookup()
    if company_id:
        company_ids = {int(company_id)} if int(company_id) in companies_by_id else set()
    else:
        company_ids = selected_company_ids_for_customer(customer_id)
    companies = [companies_by_id[linked_id] for linked_id in sorted(company_ids) if linked_id in companies_by_id]
    total_sales = money(sum((invoice.grand_total for invoice in invoices), Decimal("0.00")))
    total_received = money(sum((payment.total_amount for payment in payments), Decimal("0.00")))
    total_pending = money(sum((receivable.balance_amount for receivable in receivables), Decimal("0.00")))
    last_transaction = max([invoice.invoice_date for invoice in invoices] + [rec.document_date for rec in receivables], default=None)
    last_payment = max((payment.payment_date for payment in payments), default=None)
    pending_stock = sum((row["quantity"] for row in stock_rows if row["status"] != "Completed"), Decimal("0.000"))
    stock_given = sum((row["quantity"] for row in stock_rows), Decimal("0.000"))
    return {
        "customer": customer,
        "companies": companies,
        "invoices": invoices,
        "receivables": receivables,
        "payments": payments,
        "stock_rows": stock_rows,
        "documents": customer_documents(invoices),
        "summary": {
            "total_invoices": len(invoices),
            "total_sales": total_sales,
            "total_received": total_received,
            "total_pending": total_pending,
            "last_transaction": last_transaction,
            "last_payment": last_payment,
            "stock_given": qty(stock_given),
            "stock_received": Decimal("0.000"),
            "pending_stock": qty(pending_stock),
        },
    }
