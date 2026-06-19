from datetime import datetime
from decimal import Decimal

from app.core.formatting import money, payment_status, positive_money, positive_qty, qty
from app.extensions import db
from app.models import (
    Company,
    Customer,
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
    Supplier,
    TransferLine,
)
from app.services.audit import audit
from app.services.stock import create_fifo_layer, stock_ledger, consume_fifo
from app.services.validators import (
    active_customer,
    active_item,
    active_supplier,
    default_due,
    parse_date,
    validate_company_book,
)


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


def create_opening_stock(data, lines, user):
    company = db.session.get(Company, int(data.get("company_id") or 0))
    stock_book = db.session.get(StockBook, int(data.get("stock_book_id") or 0))
    if not company or not company.active:
        raise ValueError("Company is required.")
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
        rate = Decimal(row.get("rate"))
        if rate <= Decimal("0"):
            raise ValueError("Rate must be greater than zero.")
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
        rate = Decimal(row.get("rate"))
        if rate <= Decimal("0"):
            raise ValueError("Rate must be greater than zero.")
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


def create_transfer(data, lines, user):
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
    for row in _clean_lines(lines):
        item = active_item(row.get("item_id"))
        quantity = positive_qty(row.get("quantity"))
        line = TransferLine(transfer_id=transfer.id, item_id=item.id, quantity=quantity)
        db.session.add(line)
        db.session.flush()
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
                "Inter-company transfer out",
                getattr(user, "id", None),
            )
            dest_layer = create_fifo_layer(
                to_company.id,
                to_book.id,
                item.id,
                "TRANSFER_IN",
                transfer.id,
                line.id,
                reference,
                transfer_date,
                consumption.quantity,
                consumption.rate,
                getattr(user, "id", None),
            )
            db.session.flush()
            stock_ledger(
                to_company.id,
                to_book.id,
                item.id,
                transfer_date,
                "IN",
                "TRANSFER",
                transfer.id,
                reference,
                dest_layer.original_quantity,
                dest_layer.unit_cost,
                "Inter-company transfer in",
                getattr(user, "id", None),
            )
        line.fifo_value = line_value
        db.session.add(
            InterCompanyLedgerEntry(
                stock_owner_company_id=from_company.id,
                stock_user_company_id=to_company.id,
                transfer_id=transfer.id,
                item_id=item.id,
                quantity=quantity,
                amount_owed=line_value,
                balance_amount=line_value,
                status=payment_status(line_value, Decimal("0.00")),
                created_by_id=getattr(user, "id", None),
            )
        )
        total = money(total + line_value)
    transfer.total_fifo_value = total
    db.session.add(
        Payable(
            company_id=to_company.id,
            counterparty_company_id=from_company.id,
            source_type="INTER_COMPANY",
            source_id=transfer.id,
            document_number=reference,
            document_date=transfer_date,
            total_amount=total,
            balance_amount=total,
            payment_status=payment_status(total, Decimal("0.00")),
            remarks="Inter-company stock use",
            created_by_id=getattr(user, "id", None),
        )
    )
    db.session.add(
        Receivable(
            company_id=from_company.id,
            counterparty_company_id=to_company.id,
            source_type="INTER_COMPANY",
            source_id=transfer.id,
            document_number=reference,
            document_date=transfer_date,
            total_amount=total,
            balance_amount=total,
            payment_status=payment_status(total, Decimal("0.00")),
            remarks="Inter-company stock use",
            created_by_id=getattr(user, "id", None),
        )
    )
    audit(
        "create",
        "InterCompanyTransfer",
        transfer.id,
        reference,
        approval_reason=transfer.approval_reason,
        user=user,
    )
    return transfer


def create_opening_receivable(data, user):
    company, stock_book = validate_company_book(
        data.get("company_id"), data.get("stock_book_id"), data.get("sale_type"), "sale"
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
    company, stock_book = validate_company_book(
        data.get("company_id"), data.get("stock_book_id"), data.get("purchase_type"), "purchase"
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
