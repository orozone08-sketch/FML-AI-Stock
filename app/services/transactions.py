from datetime import date, datetime
from decimal import Decimal

from app.core.formatting import dec, money, payment_status, positive_money, positive_qty, qty
from app.extensions import db
from app.models import (
    Company,
    Customer,
    FIFOConsumption,
    InterCompanyLedgerEntry,
    InterCompanyTransfer,
    Item,
    OpeningStock,
    OpeningStockLine,
    Payable,
    Payment,
    PaymentAllocation,
    Purchase,
    PurchaseLine,
    Receivable,
    Sale,
    SaleLine,
    StockBook,
    FIFOLayer,
    StockLedgerEntry,
    Supplier,
    TransferLine,
)
from app.services.audit import audit
from app.services.stock import create_fifo_layer, stock_ledger, consume_fifo, layer_status
from app.services.validators import (
    active_customer,
    active_item,
    active_supplier,
    default_due,
    parse_date,
    validate_company_book,
)


OPENING_PENDING_REASON = "OPENING_PENDING_STOCK"
TRANSFER_ISSUE = "ISSUE"
TRANSFER_RETURN = "RETURN"
TRANSFER_OPENING = "OPENING"


def _line_total(quantity, rate, gst_percent, taxable=True):
    subtotal = money(quantity * rate)
    gst_amount = money(subtotal * Decimal(gst_percent) / Decimal("100")) if taxable else Decimal("0.00")
    return subtotal, gst_amount, money(subtotal + gst_amount)


def _clean_lines(lines):
    clean = []
    for line in lines:
        if not line.get("item_id"):
            continue
        clean.append(line)
    if not clean:
        raise ValueError("At least one item line is required.")
    return clean


def _ensure_not_void(document, label):
    if getattr(document, "is_void", False):
        raise ValueError(f"{label} has already been deleted.")


def _restore_fifo_consumptions(source_type, source_id):
    consumptions = (
        FIFOConsumption.query.filter_by(source_type=source_type, source_id=source_id)
        .order_by(FIFOConsumption.id)
        .all()
    )
    for consumption in consumptions:
        layer = consumption.fifo_layer
        restored_quantity = qty(layer.available_quantity + consumption.quantity)
        if restored_quantity > qty(layer.original_quantity):
            raise ValueError("Cannot reverse FIFO consumption beyond the original layer quantity.")
        layer.available_quantity = restored_quantity
        layer.available_value = money(restored_quantity * layer.unit_cost)
        layer.status = layer_status(layer)
        db.session.delete(consumption)


def _sync_purchase_payment(purchase, data=None):
    data = data or {}
    payment_state = (data.get("payment_status") or purchase.payment_status or "UNPAID").upper()
    if payment_state not in {"UNPAID", "PARTIAL", "PAID"}:
        raise ValueError("Invalid payment status.")
    if payment_state == "PAID":
        paid_amount = money(purchase.grand_total)
    elif payment_state == "UNPAID":
        paid_amount = Decimal("0.00")
    else:
        paid_amount = money(data.get("paid_amount") or purchase.paid_amount or "0")
        if paid_amount <= Decimal("0.00") or paid_amount >= money(purchase.grand_total):
            raise ValueError("Partial status requires a paid amount greater than zero and less than total.")
    purchase.paid_amount = paid_amount
    purchase.balance_amount = money(purchase.grand_total - paid_amount)
    purchase.payment_status = payment_state


def _sync_payable_from_purchase(purchase):
    payable = Payable.query.filter_by(source_type="PURCHASE", source_id=purchase.id).first()
    if not payable:
        return
    payable.company_id = purchase.company_id
    payable.stock_book_id = purchase.stock_book_id
    payable.supplier_id = purchase.supplier_id
    payable.document_number = purchase.bill_number
    payable.document_date = purchase.bill_date
    payable.due_date = purchase.due_date
    payable.transaction_type = purchase.purchase_type
    payable.total_amount = purchase.grand_total
    payable.paid_amount = purchase.paid_amount
    payable.balance_amount = purchase.balance_amount
    payable.payment_status = purchase.payment_status
    payable.remarks = purchase.remarks
    payable.updated_by_id = purchase.updated_by_id


def _sync_receivable_from_sale(sale):
    receivable = Receivable.query.filter_by(source_type="SALE", source_id=sale.id).first()
    if not receivable:
        return
    receivable.company_id = sale.company_id
    receivable.stock_book_id = sale.stock_book_id
    receivable.customer_id = sale.customer_id
    receivable.document_number = sale.invoice_number
    receivable.document_date = sale.invoice_date
    receivable.due_date = sale.due_date
    receivable.transaction_type = sale.sale_type
    receivable.total_amount = sale.grand_total
    receivable.paid_amount = sale.paid_amount
    receivable.balance_amount = sale.balance_amount
    receivable.payment_status = sale.payment_status
    receivable.remarks = sale.remarks
    receivable.updated_by_id = sale.updated_by_id


def _line_rows_by_id(lines, existing_lines, label):
    rows = _clean_lines(lines)
    existing = {str(line.id): line for line in existing_lines}
    if len(rows) != len(existing):
        raise ValueError(f"{label} edit can update existing item lines only.")
    ordered = []
    for row in rows:
        line_id = str(row.get("line_id") or "")
        if line_id not in existing:
            raise ValueError(f"{label} edit can update existing item lines only.")
        ordered.append((existing[line_id], row))
    return ordered


def _void_reference(reference, record_id):
    suffix = f"-VOID-{record_id}"
    base = (reference or "VOID").strip() or "VOID"
    return f"{base[: max(1, 80 - len(suffix))]}{suffix}"


def _default_stock_book(company_id, book_type=None):
    query = StockBook.query.filter_by(company_id=company_id, active=True)
    if book_type:
        stock_book = query.filter_by(book_type=book_type).order_by(StockBook.code).first()
        if stock_book:
            return stock_book
        raise ValueError(f"No active {book_type} stock book found for this company.")
    stock_book = query.filter_by(book_type="GST").order_by(StockBook.code).first()
    if stock_book:
        return stock_book
    stock_book = query.order_by(StockBook.code).first()
    if not stock_book:
        raise ValueError("No active stock book found for this company.")
    return stock_book


def _optional_opening_rate(value):
    rate = dec(value or "0")
    if rate < Decimal("0"):
        raise ValueError("Rate cannot be negative.")
    return rate


def create_opening_stock(data, lines, user):
    company = db.session.get(Company, int(data.get("company_id") or 0))
    if not company or not company.active:
        raise ValueError("Company is required.")
    stock_book = (
        db.session.get(StockBook, int(data.get("stock_book_id") or 0))
        if data.get("stock_book_id")
        else _default_stock_book(company.id)
    )
    if not stock_book or not stock_book.active:
        raise ValueError("Stock book is required.")
    if stock_book.company_id != company.id:
        raise ValueError("The selected stock book belongs to a different company.")
    opening_date = parse_date(data.get("opening_date"), "Opening date")
    reference = data.get("reference_number", "").strip()
    if not reference:
        raise ValueError("Opening reference number is required.")
    opening = OpeningStock(
        company_id=company.id,
        stock_book_id=stock_book.id,
        reference_number=reference,
        opening_date=opening_date,
        remarks=data.get("remarks") or None,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(opening)
    db.session.flush()
    for row in _clean_lines(lines):
        item = active_item(row.get("item_id"))
        quantity = positive_qty(row.get("quantity"))
        rate = _optional_opening_rate(row.get("rate"))
        line = OpeningStockLine(
            opening_stock_id=opening.id,
            item_id=item.id,
            quantity=quantity,
            rate=rate,
            value=money(quantity * rate),
            remarks=row.get("remarks") or None,
        )
        db.session.add(line)
        db.session.flush()
        create_fifo_layer(
            company.id,
            stock_book.id,
            item.id,
            "OPENING_STOCK",
            opening.id,
            line.id,
            reference,
            opening_date,
            quantity,
            rate,
            getattr(user, "id", None),
        )
        stock_ledger(
            company.id,
            stock_book.id,
            item.id,
            opening_date,
            "IN",
            "OPENING_STOCK",
            opening.id,
            reference,
            quantity,
            rate,
            "Opening stock",
            getattr(user, "id", None),
        )
    audit("create", "OpeningStock", opening.id, reference, user=user)
    return opening


def create_purchase(data, lines, user):
    company, stock_book = validate_company_book(
        data.get("company_id"), data.get("stock_book_id"), data.get("purchase_type"), "purchase"
    )
    supplier = active_supplier(data.get("supplier_id"))
    bill_number = data.get("bill_number", "").strip()
    if not bill_number:
        raise ValueError("Bill number is required.")
    bill_date = parse_date(data.get("bill_date"), "Bill date")
    due_date = parse_date(data["due_date"], "Due date") if data.get("due_date") else default_due(bill_date, supplier.default_credit_days)
    taxable = data.get("purchase_type") == "GST"
    purchase = Purchase(
        company_id=company.id,
        stock_book_id=stock_book.id,
        supplier_id=supplier.id,
        purchase_type=data.get("purchase_type"),
        bill_number=bill_number,
        bill_date=bill_date,
        due_date=due_date,
        remarks=data.get("remarks") or None,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(purchase)
    db.session.flush()
    subtotal_total = Decimal("0.00")
    gst_total = Decimal("0.00")
    grand_total = Decimal("0.00")
    for row in _clean_lines(lines):
        item = active_item(row.get("item_id"))
        quantity = positive_qty(row.get("quantity"))
        rate = Decimal(row.get("rate") or "0")
        if rate < Decimal("0"):
            raise ValueError("Rate cannot be negative.")
        gst_percent = Decimal(row.get("gst_percent") or item.gst_percent or 0)
        subtotal, gst_amount, line_total = _line_total(quantity, rate, gst_percent, taxable)
        line = PurchaseLine(
            purchase_id=purchase.id,
            item_id=item.id,
            quantity=quantity,
            rate=rate,
            gst_percent=gst_percent,
            subtotal=subtotal,
            gst_amount=gst_amount,
            line_total=line_total,
        )
        db.session.add(line)
        db.session.flush()
        create_fifo_layer(
            company.id,
            stock_book.id,
            item.id,
            "PURCHASE",
            purchase.id,
            line.id,
            bill_number,
            bill_date,
            quantity,
            rate,
            getattr(user, "id", None),
        )
        stock_ledger(
            company.id,
            stock_book.id,
            item.id,
            bill_date,
            "IN",
            "PURCHASE",
            purchase.id,
            bill_number,
            quantity,
            rate,
            "Purchase stock in",
            getattr(user, "id", None),
        )
        subtotal_total = money(subtotal_total + subtotal)
        gst_total = money(gst_total + gst_amount)
        grand_total = money(grand_total + line_total)
    purchase.subtotal = subtotal_total
    purchase.gst_total = gst_total
    purchase.grand_total = grand_total
    purchase.balance_amount = grand_total
    purchase.payment_status = payment_status(grand_total, Decimal("0.00"))
    db.session.add(
        Payable(
            company_id=company.id,
            stock_book_id=stock_book.id,
            supplier_id=supplier.id,
            source_type="PURCHASE",
            source_id=purchase.id,
            document_number=bill_number,
            document_date=bill_date,
            due_date=due_date,
            transaction_type=data.get("purchase_type"),
            total_amount=grand_total,
            balance_amount=grand_total,
            payment_status=purchase.payment_status,
            remarks=purchase.remarks,
            created_by_id=getattr(user, "id", None),
        )
    )
    audit("create", "Purchase", purchase.id, bill_number, user=user)
    return purchase


def update_purchase_header(purchase, data, user):
    _ensure_not_void(purchase, "Purchase")
    company_id = data.get("company_id") or purchase.company_id
    stock_book_id = data.get("stock_book_id") or purchase.stock_book_id
    purchase_type = data.get("purchase_type") or purchase.purchase_type
    company, stock_book = validate_company_book(
        company_id, stock_book_id, purchase_type, "purchase"
    )
    supplier = active_supplier(data.get("supplier_id"))
    bill_number = data.get("bill_number", "").strip()
    if not bill_number:
        raise ValueError("Bill number is required.")
    bill_date = parse_date(data.get("bill_date"), "Bill date")
    due_date = (
        parse_date(data["due_date"], "Due date")
        if data.get("due_date")
        else default_due(bill_date, supplier.default_credit_days)
    )
    grand_total = positive_money(data.get("grand_total") or purchase.grand_total, "Total")

    duplicate = Purchase.query.filter(
        Purchase.id != purchase.id,
        Purchase.company_id == company.id,
        Purchase.supplier_id == supplier.id,
        Purchase.bill_number == bill_number,
    ).first()
    if duplicate:
        raise ValueError("Purchase bill number already exists for this company and supplier.")

    category_changed = (
        purchase.company_id != company.id
        or purchase.stock_book_id != stock_book.id
        or purchase.purchase_type != purchase_type
    )
    if category_changed:
        consumed_layers = FIFOLayer.query.filter(
            FIFOLayer.source_type == "PURCHASE",
            FIFOLayer.source_id == purchase.id,
            FIFOLayer.available_quantity != FIFOLayer.original_quantity,
        ).count()
        if consumed_layers:
            raise ValueError("Company, stock book, or purchase type cannot be changed after this stock has been consumed.")

    before = {
        "company_id": purchase.company_id,
        "stock_book_id": purchase.stock_book_id,
        "purchase_type": purchase.purchase_type,
        "supplier_id": purchase.supplier_id,
        "bill_number": purchase.bill_number,
        "bill_date": purchase.bill_date,
        "due_date": purchase.due_date,
        "grand_total": purchase.grand_total,
        "paid_amount": purchase.paid_amount,
        "balance_amount": purchase.balance_amount,
        "payment_status": purchase.payment_status,
        "remarks": purchase.remarks,
    }

    purchase.company_id = company.id
    purchase.stock_book_id = stock_book.id
    purchase.purchase_type = purchase_type
    purchase.supplier_id = supplier.id
    purchase.bill_number = bill_number
    purchase.bill_date = bill_date
    purchase.due_date = due_date
    purchase.grand_total = grand_total
    _sync_purchase_payment(purchase, data)
    purchase.remarks = data.get("remarks") or None
    purchase.updated_by_id = getattr(user, "id", None)

    _sync_payable_from_purchase(purchase)

    FIFOLayer.query.filter_by(source_type="PURCHASE", source_id=purchase.id).update(
        {
            "company_id": company.id,
            "stock_book_id": stock_book.id,
            "source_reference": bill_number,
            "source_date": bill_date,
        },
        synchronize_session=False,
    )
    StockLedgerEntry.query.filter_by(
        transaction_type="PURCHASE", transaction_id=purchase.id
    ).update(
        {
            "company_id": company.id,
            "stock_book_id": stock_book.id,
            "reference_number": bill_number,
            "entry_date": bill_date,
        },
        synchronize_session=False,
    )

    audit(
        "edit",
        "Purchase",
        purchase.id,
        bill_number,
        before=before,
        after={
            "company_id": purchase.company_id,
            "stock_book_id": purchase.stock_book_id,
            "purchase_type": purchase.purchase_type,
            "supplier_id": purchase.supplier_id,
            "bill_number": purchase.bill_number,
            "bill_date": purchase.bill_date,
            "due_date": purchase.due_date,
            "grand_total": purchase.grand_total,
            "paid_amount": purchase.paid_amount,
            "balance_amount": purchase.balance_amount,
            "payment_status": purchase.payment_status,
            "remarks": purchase.remarks,
        },
        user=user,
    )
    return purchase


def update_purchase_lines(purchase, lines, data, user):
    _ensure_not_void(purchase, "Purchase")
    taxable = purchase.purchase_type == "GST"
    before = [
        {
            "line_id": line.id,
            "item_id": line.item_id,
            "quantity": line.quantity,
            "rate": line.rate,
            "gst_percent": line.gst_percent,
        }
        for line in purchase.lines
    ]
    ordered = _line_rows_by_id(lines, purchase.lines, "Purchase")
    subtotal_total = Decimal("0.00")
    gst_total = Decimal("0.00")
    grand_total = Decimal("0.00")

    for line, row in ordered:
        item = active_item(row.get("item_id") or line.item_id)
        if item.id != line.item_id:
            raise ValueError("Purchase item cannot be changed after saving. Delete and re-enter the purchase if the item is wrong.")
        quantity = positive_qty(row.get("quantity"))
        rate = Decimal(row.get("rate"))
        if rate <= Decimal("0"):
            raise ValueError("Rate must be greater than zero.")
        gst_percent = Decimal(row.get("gst_percent") or item.gst_percent or 0)
        changed = (
            qty(line.quantity) != quantity
            or Decimal(line.rate) != rate
            or Decimal(line.gst_percent) != gst_percent
        )
        layer = FIFOLayer.query.filter_by(
            source_type="PURCHASE",
            source_id=purchase.id,
            source_line_id=line.id,
        ).first()
        if changed and layer and qty(layer.available_quantity) != qty(layer.original_quantity):
            raise ValueError("Purchase item price or quantity cannot be changed after that stock has been consumed.")

        subtotal, gst_amount, line_total = _line_total(quantity, rate, gst_percent, taxable)
        line.quantity = quantity
        line.rate = rate
        line.gst_percent = gst_percent
        line.subtotal = subtotal
        line.gst_amount = gst_amount
        line.line_total = line_total

        if layer:
            layer.company_id = purchase.company_id
            layer.stock_book_id = purchase.stock_book_id
            layer.source_reference = purchase.bill_number
            layer.source_date = purchase.bill_date
            if changed or qty(layer.available_quantity) == qty(layer.original_quantity):
                layer.original_quantity = quantity
                layer.available_quantity = quantity
                layer.unit_cost = rate
                layer.original_value = money(quantity * rate)
                layer.available_value = money(quantity * rate)
                layer.status = layer_status(layer)

        subtotal_total = money(subtotal_total + subtotal)
        gst_total = money(gst_total + gst_amount)
        grand_total = money(grand_total + line_total)

    StockLedgerEntry.query.filter_by(
        transaction_type="PURCHASE", transaction_id=purchase.id
    ).delete(synchronize_session=False)
    for line in purchase.lines:
        stock_ledger(
            purchase.company_id,
            purchase.stock_book_id,
            line.item_id,
            purchase.bill_date,
            "IN",
            "PURCHASE",
            purchase.id,
            purchase.bill_number,
            line.quantity,
            line.rate,
            "Purchase stock in",
            getattr(user, "id", None),
        )

    purchase.subtotal = subtotal_total
    purchase.gst_total = gst_total
    purchase.grand_total = grand_total
    _sync_purchase_payment(purchase, data)
    _sync_payable_from_purchase(purchase)

    audit(
        "edit_lines",
        "Purchase",
        purchase.id,
        purchase.bill_number,
        before=before,
        after=[
            {
                "line_id": line.id,
                "item_id": line.item_id,
                "quantity": line.quantity,
                "rate": line.rate,
                "gst_percent": line.gst_percent,
            }
            for line in purchase.lines
        ],
        user=user,
    )
    return purchase


def create_sale(data, lines, user):
    company, stock_book = validate_company_book(
        data.get("company_id"), data.get("stock_book_id"), data.get("sale_type"), "sale"
    )
    customer = active_customer(data.get("customer_id"))
    invoice_number = data.get("invoice_number", "").strip()
    if not invoice_number:
        raise ValueError("Invoice number is required.")
    invoice_date = parse_date(data.get("invoice_date"), "Invoice date")
    due_date = parse_date(data["due_date"], "Due date") if data.get("due_date") else default_due(invoice_date, customer.default_credit_days)
    taxable = data.get("sale_type") == "GST"
    sale = Sale(
        company_id=company.id,
        stock_book_id=stock_book.id,
        customer_id=customer.id,
        sale_type=data.get("sale_type"),
        invoice_number=invoice_number,
        invoice_date=invoice_date,
        due_date=due_date,
        remarks=data.get("remarks") or None,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(sale)
    db.session.flush()
    subtotal_total = Decimal("0.00")
    gst_total = Decimal("0.00")
    grand_total = Decimal("0.00")
    fifo_total = Decimal("0.00")
    for row in _clean_lines(lines):
        item = active_item(row.get("item_id"))
        quantity = positive_qty(row.get("quantity"))
        sale_rate = Decimal(row.get("rate"))
        if sale_rate <= Decimal("0"):
            raise ValueError("Sale rate must be greater than zero.")
        gst_percent = Decimal(row.get("gst_percent") or item.gst_percent or 0)
        subtotal, gst_amount, line_total = _line_total(quantity, sale_rate, gst_percent, taxable)
        line = SaleLine(
            sale_id=sale.id,
            item_id=item.id,
            quantity=quantity,
            sale_rate=sale_rate,
            gst_percent=gst_percent,
            subtotal=subtotal,
            gst_amount=gst_amount,
            line_total=line_total,
        )
        db.session.add(line)
        db.session.flush()
        consumptions = consume_fifo(
            company.id, stock_book.id, item.id, quantity, "SALE", sale.id, line.id
        )
        fifo_cost = Decimal("0.00")
        for layer, consumption in consumptions:
            fifo_cost = money(fifo_cost + consumption.value)
            stock_ledger(
                company.id,
                stock_book.id,
                item.id,
                invoice_date,
                "OUT",
                "SALE",
                sale.id,
                invoice_number,
                consumption.quantity,
                consumption.rate,
                "Sale stock out",
                getattr(user, "id", None),
            )
        line.fifo_cost = fifo_cost
        line.gross_profit = money(subtotal - fifo_cost)
        subtotal_total = money(subtotal_total + subtotal)
        gst_total = money(gst_total + gst_amount)
        grand_total = money(grand_total + line_total)
        fifo_total = money(fifo_total + fifo_cost)
    sale.subtotal = subtotal_total
    sale.gst_total = gst_total
    sale.grand_total = grand_total
    sale.fifo_cost = fifo_total
    sale.gross_profit = money(subtotal_total - fifo_total)
    sale.balance_amount = grand_total
    sale.payment_status = payment_status(grand_total, Decimal("0.00"))
    db.session.add(
        Receivable(
            company_id=company.id,
            stock_book_id=stock_book.id,
            customer_id=customer.id,
            source_type="SALE",
            source_id=sale.id,
            document_number=invoice_number,
            document_date=invoice_date,
            due_date=due_date,
            transaction_type=data.get("sale_type"),
            total_amount=grand_total,
            balance_amount=grand_total,
            payment_status=sale.payment_status,
            remarks=sale.remarks,
            created_by_id=getattr(user, "id", None),
        )
    )
    audit("create", "Sale", sale.id, invoice_number, user=user)
    return sale


def update_sale_header(sale, data, user):
    _ensure_not_void(sale, "Sale")
    customer = active_customer(data.get("customer_id"))
    invoice_number = data.get("invoice_number", "").strip()
    if not invoice_number:
        raise ValueError("Invoice number is required.")
    invoice_date = parse_date(data.get("invoice_date"), "Invoice date")
    due_date = (
        parse_date(data["due_date"], "Due date")
        if data.get("due_date")
        else default_due(invoice_date, customer.default_credit_days)
    )
    if sale.paid_amount and sale.customer_id != customer.id:
        raise ValueError("Customer cannot be changed after receipt allocation.")

    before = {
        "customer_id": sale.customer_id,
        "invoice_number": sale.invoice_number,
        "invoice_date": sale.invoice_date,
        "due_date": sale.due_date,
        "remarks": sale.remarks,
    }

    sale.customer_id = customer.id
    sale.invoice_number = invoice_number
    sale.invoice_date = invoice_date
    sale.due_date = due_date
    sale.remarks = data.get("remarks") or None
    sale.updated_by_id = getattr(user, "id", None)

    receivable = Receivable.query.filter_by(source_type="SALE", source_id=sale.id).first()
    if receivable:
        _sync_receivable_from_sale(sale)

    StockLedgerEntry.query.filter_by(
        transaction_type="SALE", transaction_id=sale.id
    ).update(
        {"reference_number": invoice_number, "entry_date": invoice_date},
        synchronize_session=False,
    )

    audit(
        "edit",
        "Sale",
        sale.id,
        invoice_number,
        before=before,
        after={
            "customer_id": sale.customer_id,
            "invoice_number": sale.invoice_number,
            "invoice_date": sale.invoice_date,
            "due_date": sale.due_date,
            "remarks": sale.remarks,
        },
        user=user,
    )
    return sale


def update_sale_lines(sale, lines, user):
    _ensure_not_void(sale, "Sale")
    taxable = sale.sale_type == "GST"
    before = [
        {
            "line_id": line.id,
            "item_id": line.item_id,
            "quantity": line.quantity,
            "rate": line.sale_rate,
            "gst_percent": line.gst_percent,
        }
        for line in sale.lines
    ]
    ordered = _line_rows_by_id(lines, sale.lines, "Sale")
    changed = False
    parsed = []
    for line, row in ordered:
        item = active_item(row.get("item_id") or line.item_id)
        if item.id != line.item_id:
            raise ValueError("Sale item cannot be changed after saving. Delete and re-enter the sale if the item is wrong.")
        quantity = positive_qty(row.get("quantity"))
        sale_rate = Decimal(row.get("rate"))
        if sale_rate <= Decimal("0"):
            raise ValueError("Sale rate must be greater than zero.")
        gst_percent = Decimal(row.get("gst_percent") or item.gst_percent or 0)
        if (
            qty(line.quantity) != quantity
            or Decimal(line.sale_rate) != sale_rate
            or Decimal(line.gst_percent) != gst_percent
        ):
            changed = True
        parsed.append((line, item, quantity, sale_rate, gst_percent))

    if changed and sale.paid_amount:
        raise ValueError("Sale items cannot be changed after receipt allocation.")
    if not changed:
        return sale

    _restore_fifo_consumptions("SALE", sale.id)
    StockLedgerEntry.query.filter_by(
        transaction_type="SALE", transaction_id=sale.id
    ).delete(synchronize_session=False)

    subtotal_total = Decimal("0.00")
    gst_total = Decimal("0.00")
    grand_total = Decimal("0.00")
    fifo_total = Decimal("0.00")
    for line, item, quantity, sale_rate, gst_percent in parsed:
        subtotal, gst_amount, line_total = _line_total(quantity, sale_rate, gst_percent, taxable)
        consumptions = consume_fifo(
            sale.company_id,
            sale.stock_book_id,
            item.id,
            quantity,
            "SALE",
            sale.id,
            line.id,
        )
        fifo_cost = Decimal("0.00")
        for layer, consumption in consumptions:
            fifo_cost = money(fifo_cost + consumption.value)
            stock_ledger(
                sale.company_id,
                sale.stock_book_id,
                item.id,
                sale.invoice_date,
                "OUT",
                "SALE",
                sale.id,
                sale.invoice_number,
                consumption.quantity,
                consumption.rate,
                "Sale stock out",
                getattr(user, "id", None),
            )
        line.quantity = quantity
        line.sale_rate = sale_rate
        line.gst_percent = gst_percent
        line.subtotal = subtotal
        line.gst_amount = gst_amount
        line.line_total = line_total
        line.fifo_cost = fifo_cost
        line.gross_profit = money(subtotal - fifo_cost)
        subtotal_total = money(subtotal_total + subtotal)
        gst_total = money(gst_total + gst_amount)
        grand_total = money(grand_total + line_total)
        fifo_total = money(fifo_total + fifo_cost)

    sale.subtotal = subtotal_total
    sale.gst_total = gst_total
    sale.grand_total = grand_total
    sale.fifo_cost = fifo_total
    sale.gross_profit = money(subtotal_total - fifo_total)
    sale.paid_amount = Decimal("0.00")
    sale.balance_amount = grand_total
    sale.payment_status = payment_status(grand_total, Decimal("0.00"))
    _sync_receivable_from_sale(sale)

    audit(
        "edit_lines",
        "Sale",
        sale.id,
        sale.invoice_number,
        before=before,
        after=[
            {
                "line_id": line.id,
                "item_id": line.item_id,
                "quantity": line.quantity,
                "rate": line.sale_rate,
                "gst_percent": line.gst_percent,
            }
            for line in sale.lines
        ],
        user=user,
    )
    return sale


def _validate_transfer_parties(data):
    from_company = db.session.get(Company, int(data.get("from_company_id") or 0))
    to_company = db.session.get(Company, int(data.get("to_company_id") or 0))
    from_book = db.session.get(StockBook, int(data.get("from_stock_book_id") or 0))
    to_book = db.session.get(StockBook, int(data.get("to_stock_book_id") or 0))
    if not from_company or not from_company.active:
        raise ValueError("From company is required.")
    if not to_company or not to_company.active:
        raise ValueError("To company is required.")
    if from_company.id == to_company.id:
        raise ValueError("From and to companies must be different.")
    if not from_book or not from_book.active:
        raise ValueError("Source stock book is required.")
    if not to_book or not to_book.active:
        raise ValueError("Destination stock book is required.")
    if from_book.company_id != from_company.id:
        raise ValueError("Source stock book belongs to a different company.")
    if to_book.company_id != to_company.id:
        raise ValueError("Destination stock book belongs to a different company.")
    if from_book.id == to_book.id:
        raise ValueError("Same source and destination stock book is forbidden.")
    reference = data.get("reference_number", "").strip()
    if not reference:
        raise ValueError("Transfer reference number is required.")
    mismatch = from_book.book_type != to_book.book_type
    if mismatch and not data.get("mismatch_approved"):
        raise ValueError("This transfer crosses GST and cash stock books and requires approval.")
    transfer_date = parse_date(data.get("transfer_date"), "Transfer date")
    return from_company, to_company, from_book, to_book, reference, transfer_date


def transfer_direction(transfer):
    if transfer.is_void:
        return "VOID"
    if transfer.reason == OPENING_PENDING_REASON:
        return TRANSFER_OPENING
    if FIFOConsumption.query.filter_by(source_type="TRANSFER", source_id=transfer.id).first():
        return TRANSFER_ISSUE
    if StockLedgerEntry.query.filter_by(
        transaction_type="TRANSFER",
        transaction_id=transfer.id,
        movement_type="IN",
        company_id=transfer.to_company_id,
    ).first():
        return TRANSFER_RETURN
    return TRANSFER_ISSUE


def _append_issue_lots(lots, transfer, item_id, owner_company_id):
    if transfer_direction(transfer) == TRANSFER_OPENING:
        for line in transfer.lines:
            if line.item_id != item_id:
                continue
            quantity = qty(line.quantity)
            if quantity <= Decimal("0.000"):
                continue
            rate = money(line.fifo_value) / quantity if line.fifo_value else Decimal("0.00")
            lots.append({"quantity": quantity, "rate": rate, "transfer_id": transfer.id})
        return

    entries = (
        StockLedgerEntry.query.filter_by(
            transaction_type="TRANSFER",
            transaction_id=transfer.id,
            movement_type="OUT",
            company_id=owner_company_id,
            item_id=item_id,
        )
        .order_by(StockLedgerEntry.id)
        .all()
    )
    if entries:
        for entry in entries:
            quantity = qty(entry.quantity_out)
            if quantity > Decimal("0.000"):
                lots.append({"quantity": quantity, "rate": Decimal(entry.rate), "transfer_id": transfer.id})
        return

    for line in transfer.lines:
        if line.item_id != item_id:
            continue
        quantity = qty(line.quantity)
        if quantity <= Decimal("0.000"):
            continue
        rate = money(line.fifo_value) / quantity if line.fifo_value else Decimal("0.00")
        lots.append({"quantity": quantity, "rate": rate, "transfer_id": transfer.id})


def _subtract_lots(lots, quantity):
    remaining = qty(quantity)
    for lot in lots:
        if remaining <= Decimal("0.000"):
            break
        take = min(qty(lot["quantity"]), remaining)
        lot["quantity"] = qty(lot["quantity"] - take)
        remaining = qty(remaining - take)
    return remaining


def _apply_return_to_lots(lots, transfer, item_id, owner_company_id):
    entries = (
        StockLedgerEntry.query.filter_by(
            transaction_type="TRANSFER",
            transaction_id=transfer.id,
            movement_type="IN",
            company_id=owner_company_id,
            item_id=item_id,
        )
        .order_by(StockLedgerEntry.id)
        .all()
    )
    if entries:
        for entry in entries:
            _subtract_lots(lots, entry.quantity_in)
        return

    for line in transfer.lines:
        if line.item_id == item_id:
            _subtract_lots(lots, line.quantity)


def pending_transfer_lots(
    owner_company_id,
    user_company_id,
    item_id,
    before_date=None,
    through_date=None,
    exclude_transfer_id=None,
):
    query = InterCompanyTransfer.query.filter(
        InterCompanyTransfer.is_void.is_(False),
        db.or_(
            db.and_(
                InterCompanyTransfer.from_company_id == owner_company_id,
                InterCompanyTransfer.to_company_id == user_company_id,
            ),
            db.and_(
                InterCompanyTransfer.from_company_id == user_company_id,
                InterCompanyTransfer.to_company_id == owner_company_id,
            ),
        ),
    )
    if before_date:
        query = query.filter(InterCompanyTransfer.transfer_date < before_date)
    if through_date:
        query = query.filter(InterCompanyTransfer.transfer_date <= through_date)
    transfers = query.order_by(InterCompanyTransfer.transfer_date, InterCompanyTransfer.id).all()
    lots = []
    for transfer in transfers:
        if exclude_transfer_id and transfer.id == exclude_transfer_id:
            continue
        direction = transfer_direction(transfer)
        if (
            transfer.from_company_id == owner_company_id
            and transfer.to_company_id == user_company_id
            and direction in {TRANSFER_ISSUE, TRANSFER_OPENING}
        ):
            _append_issue_lots(lots, transfer, item_id, owner_company_id)
        elif (
            transfer.from_company_id == user_company_id
            and transfer.to_company_id == owner_company_id
            and direction == TRANSFER_RETURN
        ):
            _apply_return_to_lots(lots, transfer, item_id, owner_company_id)
    return [lot for lot in lots if qty(lot["quantity"]) > Decimal("0.000")]


def pending_transfer_quantity(owner_company_id, user_company_id, item_id, **kwargs):
    return qty(
        sum(
            (qty(lot["quantity"]) for lot in pending_transfer_lots(owner_company_id, user_company_id, item_id, **kwargs)),
            Decimal("0.000"),
        )
    )


def _consume_pending_lots(lots, quantity):
    required = qty(quantity)
    available = qty(sum((qty(lot["quantity"]) for lot in lots), Decimal("0.000")))
    if available < required:
        raise ValueError(f"Cannot return more stock than pending. Pending: {available}; requested: {required}.")
    remaining = required
    pieces = []
    total_value = Decimal("0.00")
    for lot in lots:
        if remaining <= Decimal("0.000"):
            break
        take = min(qty(lot["quantity"]), remaining)
        value = money(take * lot["rate"])
        pieces.append((take, lot["rate"], value))
        total_value = money(total_value + value)
        remaining = qty(remaining - take)
    return pieces, total_value


def _transfer_line_sum(owner_company_id, user_company_id, item_id, start_date, end_date, directions):
    total = Decimal("0.000")
    transfers = (
        InterCompanyTransfer.query.filter(
            InterCompanyTransfer.is_void.is_(False),
            InterCompanyTransfer.transfer_date >= start_date,
            InterCompanyTransfer.transfer_date <= end_date,
            db.or_(
                db.and_(
                    InterCompanyTransfer.from_company_id == owner_company_id,
                    InterCompanyTransfer.to_company_id == user_company_id,
                ),
                db.and_(
                    InterCompanyTransfer.from_company_id == user_company_id,
                    InterCompanyTransfer.to_company_id == owner_company_id,
                ),
            ),
        )
        .order_by(InterCompanyTransfer.transfer_date, InterCompanyTransfer.id)
        .all()
    )
    for transfer in transfers:
        direction = transfer_direction(transfer)
        matches_issue = (
            transfer.from_company_id == owner_company_id
            and transfer.to_company_id == user_company_id
            and direction in directions
        )
        matches_return = (
            transfer.from_company_id == user_company_id
            and transfer.to_company_id == owner_company_id
            and direction in directions
        )
        if not (matches_issue or matches_return):
            continue
        for line in transfer.lines:
            if line.item_id == item_id:
                total = qty(total + line.quantity)
    return qty(total)


def pending_transfer_summary(as_of=None):
    as_of = as_of or date.today()
    month_start = as_of.replace(day=1)
    keys = set()
    transfers = InterCompanyTransfer.query.filter_by(is_void=False).all()
    for transfer in transfers:
        direction = transfer_direction(transfer)
        if direction in {TRANSFER_ISSUE, TRANSFER_OPENING}:
            owner_id = transfer.from_company_id
            user_id = transfer.to_company_id
        elif direction == TRANSFER_RETURN:
            owner_id = transfer.to_company_id
            user_id = transfer.from_company_id
        else:
            continue
        for line in transfer.lines:
            keys.add((owner_id, user_id, line.item_id))

    rows = []
    for owner_id, user_id, item_id in sorted(keys):
        opening = pending_transfer_quantity(
            owner_id,
            user_id,
            item_id,
            before_date=month_start,
            through_date=as_of,
        )
        opening = qty(
            opening
            + _transfer_line_sum(
                owner_id,
                user_id,
                item_id,
                month_start,
                as_of,
                {TRANSFER_OPENING},
            )
        )
        issued = _transfer_line_sum(
            owner_id,
            user_id,
            item_id,
            month_start,
            as_of,
            {TRANSFER_ISSUE},
        )
        returned = _transfer_line_sum(
            owner_id,
            user_id,
            item_id,
            month_start,
            as_of,
            {TRANSFER_RETURN},
        )
        pending = qty(opening + issued - returned)
        if opening or issued or returned or pending:
            rows.append(
                {
                    "owner": db.session.get(Company, owner_id),
                    "user": db.session.get(Company, user_id),
                    "item": db.session.get(Item, item_id),
                    "opening": opening,
                    "issued": issued,
                    "returned": returned,
                    "pending": pending,
                }
            )
    return rows


def create_transfer(data, lines, user):
    from_company, to_company, from_book, to_book, reference, transfer_date = _validate_transfer_parties(data)
    parsed_lines = []
    has_pending_return = False
    for row in _clean_lines(lines):
        item = active_item(row.get("item_id"))
        quantity = positive_qty(row.get("quantity"))
        pending = pending_transfer_quantity(to_company.id, from_company.id, item.id)
        has_pending_return = has_pending_return or pending > Decimal("0.000")
        parsed_lines.append({"item": item, "quantity": quantity, "pending": pending})

    if has_pending_return:
        for row in parsed_lines:
            if row["pending"] < row["quantity"]:
                raise ValueError(
                    f"Cannot return more {row['item'].code} stock than pending. "
                    f"Pending: {row['pending']}; requested: {row['quantity']}."
                )

    transfer = InterCompanyTransfer(
        from_company_id=from_company.id,
        from_stock_book_id=from_book.id,
        to_company_id=to_company.id,
        to_stock_book_id=to_book.id,
        reference_number=reference,
        transfer_date=transfer_date,
        reason=data.get("reason") or None,
        remarks=data.get("remarks") or None,
        mismatch_approved=bool(data.get("mismatch_approved")),
        approval_reason=data.get("approval_reason") or None,
        approved_by_id=getattr(user, "id", None) if data.get("mismatch_approved") else None,
        approved_at=datetime.utcnow() if data.get("mismatch_approved") else None,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(transfer)
    db.session.flush()
    total = Decimal("0.00")
    for row in parsed_lines:
        item = row["item"]
        quantity = row["quantity"]
        line = TransferLine(transfer_id=transfer.id, item_id=item.id, quantity=quantity)
        db.session.add(line)
        db.session.flush()
        if has_pending_return:
            pieces, line_value = _consume_pending_lots(
                pending_transfer_lots(to_company.id, from_company.id, item.id),
                quantity,
            )
            for piece_quantity, rate, _value in pieces:
                create_fifo_layer(
                    to_company.id,
                    to_book.id,
                    item.id,
                    "TRANSFER_RETURN",
                    transfer.id,
                    line.id,
                    reference,
                    transfer_date,
                    piece_quantity,
                    rate,
                    getattr(user, "id", None),
                )
                stock_ledger(
                    to_company.id,
                    to_book.id,
                    item.id,
                    transfer_date,
                    "IN",
                    "TRANSFER",
                    transfer.id,
                    reference,
                    piece_quantity,
                    rate,
                    "Inter-company stock returned",
                    getattr(user, "id", None),
                )
            db.session.add(
                InterCompanyLedgerEntry(
                    stock_owner_company_id=to_company.id,
                    stock_user_company_id=from_company.id,
                    transfer_id=transfer.id,
                    item_id=item.id,
                    quantity=qty(Decimal("0.000") - quantity),
                    amount_owed=money(Decimal("0.00") - line_value),
                    balance_amount=Decimal("0.00"),
                    status="RETURNED",
                    created_by_id=getattr(user, "id", None),
                )
            )
        else:
            consumptions = consume_fifo(
                from_company.id, from_book.id, item.id, quantity, "TRANSFER", transfer.id, line.id
            )
            line_value = Decimal("0.00")
            for layer, consumption in consumptions:
                line_value = money(line_value + consumption.value)
                stock_ledger(
                    from_company.id,
                    from_book.id,
                    item.id,
                    transfer_date,
                    "OUT",
                    "TRANSFER",
                    transfer.id,
                    reference,
                    consumption.quantity,
                    consumption.rate,
                    "Inter-company stock issued",
                    getattr(user, "id", None),
                )
            db.session.add(
                InterCompanyLedgerEntry(
                    stock_owner_company_id=from_company.id,
                    stock_user_company_id=to_company.id,
                    transfer_id=transfer.id,
                    item_id=item.id,
                    quantity=quantity,
                    amount_owed=line_value,
                    balance_amount=line_value,
                    status="PENDING",
                    created_by_id=getattr(user, "id", None),
                )
            )
        line.fifo_value = line_value
        total = money(total + line_value)
    transfer.total_fifo_value = total
    audit(
        "create",
        "InterCompanyTransfer",
        transfer.id,
        reference,
        after={"transfer_type": TRANSFER_RETURN if has_pending_return else TRANSFER_ISSUE},
        approval_reason=transfer.approval_reason,
        user=user,
    )
    return transfer


def create_opening_pending_stock(data, lines, user):
    from_company_id = int(data.get("from_company_id") or 0)
    to_company_id = int(data.get("to_company_id") or 0)
    from_stock_book_id = data.get("from_stock_book_id")
    to_stock_book_id = data.get("to_stock_book_id")
    if not from_stock_book_id and from_company_id:
        from_stock_book_id = _default_stock_book(from_company_id).id
    if not to_stock_book_id and to_company_id:
        to_stock_book_id = _default_stock_book(to_company_id).id
    from_company, to_company, from_book, to_book, reference, transfer_date = _validate_transfer_parties(
        {
            **data,
            "from_stock_book_id": from_stock_book_id,
            "to_stock_book_id": to_stock_book_id,
            "mismatch_approved": data.get("mismatch_approved") or "1",
        }
    )
    transfer = InterCompanyTransfer(
        from_company_id=from_company.id,
        from_stock_book_id=from_book.id,
        to_company_id=to_company.id,
        to_stock_book_id=to_book.id,
        reference_number=reference,
        transfer_date=transfer_date,
        reason=OPENING_PENDING_REASON,
        remarks=data.get("remarks") or None,
        mismatch_approved=bool(data.get("mismatch_approved")),
        approval_reason=data.get("approval_reason") or None,
        approved_by_id=getattr(user, "id", None) if data.get("mismatch_approved") else None,
        approved_at=datetime.utcnow() if data.get("mismatch_approved") else None,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(transfer)
    db.session.flush()
    total = Decimal("0.00")
    for row in _clean_lines(lines):
        item = active_item(row.get("item_id"))
        quantity = positive_qty(row.get("quantity"))
        rate = _optional_opening_rate(row.get("rate"))
        line_value = money(quantity * rate)
        line = TransferLine(
            transfer_id=transfer.id,
            item_id=item.id,
            quantity=quantity,
            fifo_value=line_value,
        )
        db.session.add(line)
        db.session.add(
            InterCompanyLedgerEntry(
                stock_owner_company_id=from_company.id,
                stock_user_company_id=to_company.id,
                transfer_id=transfer.id,
                item_id=item.id,
                quantity=quantity,
                amount_owed=line_value,
                balance_amount=line_value,
                status="PENDING",
                created_by_id=getattr(user, "id", None),
            )
        )
        total = money(total + line_value)
    transfer.total_fifo_value = total
    audit(
        "create",
        "OpeningPendingStock",
        transfer.id,
        reference,
        after={"transfer_type": TRANSFER_OPENING},
        user=user,
    )
    return transfer


def update_transfer_header(transfer, data, user):
    _ensure_not_void(transfer, "Transfer")
    reference = data.get("reference_number", "").strip()
    if not reference:
        raise ValueError("Transfer reference number is required.")
    transfer_date = parse_date(data.get("transfer_date"), "Transfer date")
    mismatch_approved = bool(data.get("mismatch_approved"))

    before = {
        "reference_number": transfer.reference_number,
        "transfer_date": transfer.transfer_date,
        "reason": transfer.reason,
        "remarks": transfer.remarks,
        "mismatch_approved": transfer.mismatch_approved,
        "approval_reason": transfer.approval_reason,
    }

    transfer.reference_number = reference
    transfer.transfer_date = transfer_date
    transfer.reason = OPENING_PENDING_REASON if transfer.reason == OPENING_PENDING_REASON else data.get("reason") or None
    transfer.remarks = data.get("remarks") or None
    transfer.mismatch_approved = mismatch_approved
    transfer.approval_reason = data.get("approval_reason") or None
    if mismatch_approved and not transfer.approved_by_id:
        transfer.approved_by_id = getattr(user, "id", None)
        transfer.approved_at = datetime.utcnow()
    if not mismatch_approved:
        transfer.approved_by_id = None
        transfer.approved_at = None
    transfer.updated_by_id = getattr(user, "id", None)

    StockLedgerEntry.query.filter_by(
        transaction_type="TRANSFER", transaction_id=transfer.id
    ).update(
        {"reference_number": reference, "entry_date": transfer_date},
        synchronize_session=False,
    )
    FIFOLayer.query.filter(
        FIFOLayer.source_type.in_(["TRANSFER_IN", "TRANSFER_RETURN"]),
        FIFOLayer.source_id == transfer.id,
    ).update(
        {"source_reference": reference, "source_date": transfer_date},
        synchronize_session=False,
    )
    Payable.query.filter_by(source_type="INTER_COMPANY", source_id=transfer.id).update(
        {"document_number": reference, "document_date": transfer_date},
        synchronize_session=False,
    )
    Receivable.query.filter_by(source_type="INTER_COMPANY", source_id=transfer.id).update(
        {"document_number": reference, "document_date": transfer_date},
        synchronize_session=False,
    )

    audit(
        "edit",
        "InterCompanyTransfer",
        transfer.id,
        reference,
        before=before,
        after={
            "reference_number": transfer.reference_number,
            "transfer_date": transfer.transfer_date,
            "reason": transfer.reason,
            "remarks": transfer.remarks,
            "mismatch_approved": transfer.mismatch_approved,
            "approval_reason": transfer.approval_reason,
        },
        approval_reason=transfer.approval_reason,
        user=user,
    )
    return transfer


def _has_later_return(owner_company_id, user_company_id, item_id, transfer):
    candidates = (
        InterCompanyTransfer.query.filter(
            InterCompanyTransfer.is_void.is_(False),
            InterCompanyTransfer.from_company_id == user_company_id,
            InterCompanyTransfer.to_company_id == owner_company_id,
            db.or_(
                InterCompanyTransfer.transfer_date > transfer.transfer_date,
                db.and_(
                    InterCompanyTransfer.transfer_date == transfer.transfer_date,
                    InterCompanyTransfer.id > transfer.id,
                ),
            ),
        )
        .order_by(InterCompanyTransfer.transfer_date, InterCompanyTransfer.id)
        .all()
    )
    for candidate in candidates:
        if transfer_direction(candidate) != TRANSFER_RETURN:
            continue
        if any(line.item_id == item_id for line in candidate.lines):
            return True
    return False


def void_purchase(purchase, user):
    _ensure_not_void(purchase, "Purchase")
    if purchase.paid_amount:
        raise ValueError("Purchase cannot be deleted after payment allocation.")
    consumed_layers = FIFOLayer.query.filter(
        FIFOLayer.source_type == "PURCHASE",
        FIFOLayer.source_id == purchase.id,
        FIFOLayer.available_quantity != FIFOLayer.original_quantity,
    ).count()
    if consumed_layers:
        raise ValueError("Purchase cannot be deleted after its stock has been consumed.")
    reference = purchase.bill_number
    Payable.query.filter_by(source_type="PURCHASE", source_id=purchase.id).delete(
        synchronize_session=False
    )
    StockLedgerEntry.query.filter_by(
        transaction_type="PURCHASE", transaction_id=purchase.id
    ).delete(synchronize_session=False)
    FIFOLayer.query.filter_by(source_type="PURCHASE", source_id=purchase.id).delete(
        synchronize_session=False
    )
    purchase.is_void = True
    purchase.bill_number = _void_reference(purchase.bill_number, purchase.id)
    purchase.updated_by_id = getattr(user, "id", None)
    audit("delete", "Purchase", purchase.id, reference, user=user)
    return purchase


def void_sale(sale, user):
    _ensure_not_void(sale, "Sale")
    if sale.paid_amount:
        raise ValueError("Sale cannot be deleted after receipt allocation.")
    reference = sale.invoice_number
    _restore_fifo_consumptions("SALE", sale.id)
    StockLedgerEntry.query.filter_by(transaction_type="SALE", transaction_id=sale.id).delete(
        synchronize_session=False
    )
    Receivable.query.filter_by(source_type="SALE", source_id=sale.id).delete(
        synchronize_session=False
    )
    sale.is_void = True
    sale.invoice_number = _void_reference(sale.invoice_number, sale.id)
    sale.updated_by_id = getattr(user, "id", None)
    audit("delete", "Sale", sale.id, reference, user=user)
    return sale


def void_transfer(transfer, user):
    _ensure_not_void(transfer, "Transfer")
    direction = transfer_direction(transfer)
    reference = transfer.reference_number
    if direction in {TRANSFER_ISSUE, TRANSFER_OPENING}:
        for line in transfer.lines:
            if _has_later_return(
                transfer.from_company_id,
                transfer.to_company_id,
                line.item_id,
                transfer,
            ):
                raise ValueError("Transfer cannot be deleted after stock has been returned against it.")
        _restore_fifo_consumptions("TRANSFER", transfer.id)
        destination_layers = FIFOLayer.query.filter_by(
            source_type="TRANSFER_IN",
            source_id=transfer.id,
        ).all()
        for layer in destination_layers:
            if qty(layer.available_quantity) != qty(layer.original_quantity):
                raise ValueError("Transfer cannot be deleted after destination stock has been consumed.")
            db.session.delete(layer)
    elif direction == TRANSFER_RETURN:
        returned_layers = FIFOLayer.query.filter_by(
            source_type="TRANSFER_RETURN",
            source_id=transfer.id,
        ).all()
        for layer in returned_layers:
            if qty(layer.available_quantity) != qty(layer.original_quantity):
                raise ValueError("Return cannot be deleted after returned stock has been consumed.")
            db.session.delete(layer)

    StockLedgerEntry.query.filter_by(
        transaction_type="TRANSFER", transaction_id=transfer.id
    ).delete(synchronize_session=False)
    InterCompanyLedgerEntry.query.filter_by(transfer_id=transfer.id).delete(
        synchronize_session=False
    )
    Payable.query.filter_by(source_type="INTER_COMPANY", source_id=transfer.id).delete(
        synchronize_session=False
    )
    Receivable.query.filter_by(source_type="INTER_COMPANY", source_id=transfer.id).delete(
        synchronize_session=False
    )
    transfer.is_void = True
    transfer.reference_number = _void_reference(transfer.reference_number, transfer.id)
    transfer.updated_by_id = getattr(user, "id", None)
    audit("delete", "InterCompanyTransfer", transfer.id, reference, user=user)
    return transfer


def void_opening_stock(opening, user):
    _ensure_not_void(opening, "Opening stock")
    consumed_layers = FIFOLayer.query.filter(
        FIFOLayer.source_type == "OPENING_STOCK",
        FIFOLayer.source_id == opening.id,
        FIFOLayer.available_quantity != FIFOLayer.original_quantity,
    ).count()
    if consumed_layers:
        raise ValueError("Opening stock cannot be deleted after it has been consumed.")
    reference = opening.reference_number
    StockLedgerEntry.query.filter_by(
        transaction_type="OPENING_STOCK", transaction_id=opening.id
    ).delete(synchronize_session=False)
    FIFOLayer.query.filter_by(source_type="OPENING_STOCK", source_id=opening.id).delete(
        synchronize_session=False
    )
    opening.is_void = True
    opening.reference_number = _void_reference(opening.reference_number, opening.id)
    opening.updated_by_id = getattr(user, "id", None)
    audit("delete", "OpeningStock", opening.id, reference, user=user)
    return opening


def create_opening_receivable(data, user):
    company = db.session.get(Company, int(data.get("company_id") or 0))
    if not company or not company.active:
        raise ValueError("Company is required.")
    stock_book_id = data.get("stock_book_id") or _default_stock_book(
        company.id, data.get("sale_type") or "GST"
    ).id
    company, stock_book = validate_company_book(
        company.id, stock_book_id, data.get("sale_type"), "sale"
    )
    customer = active_customer(data.get("customer_id"))
    amount = positive_money(data.get("pending_amount"), "Pending amount")
    document_date = parse_date(data.get("invoice_date"), "Invoice date")
    due_date = parse_date(data.get("due_date"), "Due date")
    number = data.get("reference_number", "").strip()
    if not number:
        raise ValueError("Old invoice/reference number is required.")
    receivable = Receivable(
        company_id=company.id,
        stock_book_id=stock_book.id,
        customer_id=customer.id,
        source_type="OPENING_RECEIVABLE",
        source_id=0,
        document_number=number,
        document_date=document_date,
        due_date=due_date,
        transaction_type=data.get("sale_type"),
        total_amount=amount,
        balance_amount=amount,
        payment_status=payment_status(amount, Decimal("0.00")),
        remarks=data.get("remarks") or None,
        is_opening=True,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(receivable)
    db.session.flush()
    receivable.source_id = receivable.id
    audit("create", "OpeningReceivable", receivable.id, number, user=user)
    return receivable


def create_opening_payable(data, user):
    company = db.session.get(Company, int(data.get("company_id") or 0))
    if not company or not company.active:
        raise ValueError("Company is required.")
    stock_book_id = data.get("stock_book_id") or _default_stock_book(
        company.id, data.get("purchase_type") or "GST"
    ).id
    company, stock_book = validate_company_book(
        company.id, stock_book_id, data.get("purchase_type"), "purchase"
    )
    supplier = active_supplier(data.get("supplier_id"))
    amount = positive_money(data.get("pending_amount"), "Pending amount")
    document_date = parse_date(data.get("bill_date"), "Bill date")
    due_date = parse_date(data.get("due_date"), "Due date")
    number = data.get("reference_number", "").strip()
    if not number:
        raise ValueError("Old bill/reference number is required.")
    payable = Payable(
        company_id=company.id,
        stock_book_id=stock_book.id,
        supplier_id=supplier.id,
        source_type="OPENING_PAYABLE",
        source_id=0,
        document_number=number,
        document_date=document_date,
        due_date=due_date,
        transaction_type=data.get("purchase_type"),
        total_amount=amount,
        balance_amount=amount,
        payment_status=payment_status(amount, Decimal("0.00")),
        remarks=data.get("remarks") or None,
        is_opening=True,
        created_by_id=getattr(user, "id", None),
    )
    db.session.add(payable)
    db.session.flush()
    payable.source_id = payable.id
    audit("create", "OpeningPayable", payable.id, number, user=user)
    return payable


def create_opening_advance_received(data, user):
    customer = active_customer(data.get("customer_id"))
    amount = positive_money(data.get("amount"), "Amount")
    payment = Payment(
        company_id=int(data["company_id"]),
        payment_type="OPENING_ADVANCE_RECEIVED",
        party_type="CUSTOMER",
        customer_id=customer.id,
        payment_date=parse_date(data.get("payment_date"), "Payment date"),
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
    audit("create", "OpeningAdvanceReceived", payment.id, payment.reference_number, user=user)
    return payment


def create_opening_advance_paid(data, user):
    supplier = active_supplier(data.get("supplier_id"))
    amount = positive_money(data.get("amount"), "Amount")
    payment = Payment(
        company_id=int(data["company_id"]),
        payment_type="OPENING_ADVANCE_PAID",
        party_type="SUPPLIER",
        supplier_id=supplier.id,
        payment_date=parse_date(data.get("payment_date"), "Payment date"),
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
    audit("create", "OpeningAdvancePaid", payment.id, payment.reference_number, user=user)
    return payment
