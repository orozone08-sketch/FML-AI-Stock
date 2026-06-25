from collections import OrderedDict, defaultdict
from decimal import Decimal

from app.core.formatting import money, qty
from app.extensions import db
from app.models import (
    InterCompanyLedgerEntry,
    InterCompanyTransfer,
    OpeningStock,
    OpeningStockLine,
    Purchase,
    PurchaseLine,
    Sale,
    SaleLine,
    StockLedgerEntry,
)


def movement_query(item_id, company_id=None, stock_book_id=None, date_from=None, date_to=None):
    query = StockLedgerEntry.query.filter(StockLedgerEntry.item_id == item_id)
    if company_id:
        query = query.filter(StockLedgerEntry.company_id == company_id)
    if stock_book_id:
        query = query.filter(StockLedgerEntry.stock_book_id == stock_book_id)
    if date_from:
        query = query.filter(StockLedgerEntry.entry_date >= date_from)
    if date_to:
        query = query.filter(StockLedgerEntry.entry_date <= date_to)
    return query.order_by(StockLedgerEntry.entry_date, StockLedgerEntry.id)


def movement_key(entry):
    return (
        entry.company_id,
        entry.stock_book_id,
        entry.item_id,
        entry.entry_date,
        entry.transaction_type,
        entry.transaction_id,
        entry.reference_number,
        entry.movement_type,
    )


def grouped_movements(entries):
    groups = OrderedDict()
    for entry in entries:
        key = movement_key(entry)
        group = groups.setdefault(
            key,
            {
                "ids": [],
                "company": entry.company,
                "stock_book": entry.stock_book,
                "item": entry.item,
                "date": entry.entry_date,
                "movement_type": entry.movement_type,
                "transaction_type": entry.transaction_type,
                "transaction_id": entry.transaction_id,
                "reference": entry.reference_number,
                "quantity_in": Decimal("0.000"),
                "quantity_out": Decimal("0.000"),
                "value": Decimal("0.00"),
                "remarks": entry.remarks or "",
            },
        )
        group["ids"].append(entry.id)
        group["quantity_in"] = qty(group["quantity_in"] + entry.quantity_in)
        group["quantity_out"] = qty(group["quantity_out"] + entry.quantity_out)
        group["value"] = money(group["value"] + entry.value)
        if entry.remarks and entry.remarks not in group["remarks"]:
            group["remarks"] = f"{group['remarks']}; {entry.remarks}" if group["remarks"] else entry.remarks
    return list(groups.values())


def source_group(company, stock_book, item, entry_date, movement_type, transaction_type, transaction_id, reference, quantity, value, remarks=""):
    quantity = qty(quantity)
    return {
        "ids": [],
        "company": company,
        "stock_book": stock_book,
        "item": item,
        "date": entry_date,
        "movement_type": movement_type,
        "transaction_type": transaction_type,
        "transaction_id": transaction_id,
        "reference": reference,
        "quantity_in": quantity if movement_type == "IN" else Decimal("0.000"),
        "quantity_out": quantity if movement_type == "OUT" else Decimal("0.000"),
        "value": money(value),
        "remarks": remarks,
    }


def source_line_movements(item_id, company_id=None, stock_book_id=None, date_from=None, date_to=None):
    rows = []

    opening_lines = OpeningStockLine.query.join(OpeningStock).filter(
        OpeningStockLine.item_id == item_id,
        OpeningStock.is_void.is_(False),
    )
    if company_id:
        opening_lines = opening_lines.filter(OpeningStock.company_id == company_id)
    if stock_book_id:
        opening_lines = opening_lines.filter(OpeningStock.stock_book_id == stock_book_id)
    if date_from:
        opening_lines = opening_lines.filter(OpeningStock.opening_date >= date_from)
    if date_to:
        opening_lines = opening_lines.filter(OpeningStock.opening_date <= date_to)
    for line in opening_lines.all():
        movement_type = "IN" if line.quantity > Decimal("0.000") else "OUT"
        rows.append(
            source_group(
                line.opening_stock.company,
                line.opening_stock.stock_book,
                line.item,
                line.opening_stock.opening_date,
                movement_type,
                "OPENING_STOCK",
                line.opening_stock_id,
                line.opening_stock.reference_number,
                abs(line.quantity),
                abs(line.value),
                "Opening stock",
            )
        )

    purchase_lines = PurchaseLine.query.join(Purchase).filter(
        PurchaseLine.item_id == item_id,
        Purchase.is_void.is_(False),
    )
    if company_id:
        purchase_lines = purchase_lines.filter(Purchase.company_id == company_id)
    if stock_book_id:
        purchase_lines = purchase_lines.filter(Purchase.stock_book_id == stock_book_id)
    if date_from:
        purchase_lines = purchase_lines.filter(Purchase.bill_date >= date_from)
    if date_to:
        purchase_lines = purchase_lines.filter(Purchase.bill_date <= date_to)
    for line in purchase_lines.all():
        rows.append(
            source_group(
                line.purchase.company,
                line.purchase.stock_book,
                line.item,
                line.purchase.bill_date,
                "IN",
                "PURCHASE",
                line.purchase_id,
                line.purchase.bill_number,
                line.quantity,
                line.subtotal,
                "Purchase stock in",
            )
        )

    sale_lines = SaleLine.query.join(Sale).filter(
        SaleLine.item_id == item_id,
        Sale.is_void.is_(False),
    )
    if company_id:
        sale_lines = sale_lines.filter(Sale.company_id == company_id)
    if stock_book_id:
        sale_lines = sale_lines.filter(Sale.stock_book_id == stock_book_id)
    if date_from:
        sale_lines = sale_lines.filter(Sale.invoice_date >= date_from)
    if date_to:
        sale_lines = sale_lines.filter(Sale.invoice_date <= date_to)
    for line in sale_lines.all():
        sale_value = line.fifo_cost if money(line.fifo_cost) > Decimal("0.00") else line.subtotal
        rows.append(
            source_group(
                line.sale.company,
                line.sale.stock_book,
                line.item,
                line.sale.invoice_date,
                "OUT",
                "SALE",
                line.sale_id,
                line.sale.invoice_number,
                line.quantity,
                sale_value,
                "Sale stock out",
            )
        )

    transfer_entries = InterCompanyLedgerEntry.query.join(InterCompanyLedgerEntry.transfer).filter(
        InterCompanyLedgerEntry.item_id == item_id,
        InterCompanyTransfer.is_void.is_(False),
    )
    if company_id:
        transfer_entries = transfer_entries.filter(InterCompanyLedgerEntry.stock_owner_company_id == company_id)
    if date_from:
        transfer_entries = transfer_entries.filter(InterCompanyTransfer.transfer_date >= date_from)
    if date_to:
        transfer_entries = transfer_entries.filter(InterCompanyTransfer.transfer_date <= date_to)
    for entry in transfer_entries.all():
        movement_type = "IN" if entry.quantity < Decimal("0.000") else "OUT"
        stock_book = entry.transfer.to_stock_book if movement_type == "IN" else entry.transfer.from_stock_book
        if stock_book_id and stock_book.id != int(stock_book_id):
            continue
        rows.append(
            source_group(
                entry.owner_company,
                stock_book,
                entry.item,
                entry.transfer.transfer_date,
                movement_type,
                "TRANSFER",
                entry.transfer_id,
                entry.transfer.reference_number,
                abs(entry.quantity),
                abs(entry.amount_owed),
                "Inter-company stock returned" if movement_type == "IN" else "Inter-company stock issued",
            )
        )

    return sorted(rows, key=lambda row: (row["date"], row["transaction_type"], row["transaction_id"]))


def purchase_item_bill_value(purchase_id, item_id):
    return money(
        sum(
            (line.line_total for line in PurchaseLine.query.filter_by(purchase_id=purchase_id, item_id=item_id).all()),
            Decimal("0.00"),
        )
    )


def sale_item_bill_value(sale_id, item_id):
    return money(
        sum(
            (line.line_total for line in SaleLine.query.filter_by(sale_id=sale_id, item_id=item_id).all()),
            Decimal("0.00"),
        )
    )


def opening_item_value(opening_id, item_id):
    opening = db.session.get(OpeningStock, opening_id)
    if not opening:
        return Decimal("0.00")
    return money(sum((abs(line.value) for line in opening.lines if line.item_id == item_id), Decimal("0.00")))


def source_details(group):
    source_type = group["transaction_type"]
    source_id = group["transaction_id"]
    item_id = group["item"].id
    if source_type == "PURCHASE":
        purchase = db.session.get(Purchase, source_id)
        if purchase:
            return {
                "particulars": purchase.supplier.name,
                "party_kind": "Supplier",
                "voucher_type": "Purchase",
                "voucher_no": purchase.bill_number,
                "voucher_amount": purchase_item_bill_value(purchase.id, item_id),
            }
    if source_type == "SALE":
        sale = db.session.get(Sale, source_id)
        if sale:
            return {
                "particulars": sale.customer.name,
                "party_kind": "Debtor",
                "voucher_type": "Sales",
                "voucher_no": sale.invoice_number,
                "voucher_amount": sale_item_bill_value(sale.id, item_id),
            }
    if source_type == "TRANSFER":
        transfer = db.session.get(InterCompanyTransfer, source_id)
        if transfer:
            if group["movement_type"] == "IN":
                particulars = f"Received from {transfer.from_company.name}"
            else:
                particulars = f"Issued to {transfer.to_company.name}"
            return {
                "particulars": particulars,
                "party_kind": "Inter Co",
                "voucher_type": "Transfer",
                "voucher_no": transfer.reference_number,
                "voucher_amount": money(sum((line.fifo_value for line in transfer.lines if line.item_id == item_id), Decimal("0.00"))),
            }
    if source_type == "OPENING_STOCK":
        opening = db.session.get(OpeningStock, source_id)
        return {
            "particulars": "Opening Balance",
            "party_kind": "Opening",
            "voucher_type": "Opening",
            "voucher_no": opening.reference_number if opening else group["reference"],
            "voucher_amount": opening_item_value(source_id, item_id),
        }
    return {
        "particulars": group["reference"],
        "party_kind": source_type.replace("_", " ").title(),
        "voucher_type": source_type.replace("_", " ").title(),
        "voucher_no": group["reference"],
        "voucher_amount": money(group["value"]),
    }


def empty_summary():
    return {
        "inward_qty": Decimal("0.000"),
        "outward_qty": Decimal("0.000"),
        "closing_qty": Decimal("0.000"),
        "inward_value": Decimal("0.00"),
        "outward_value": Decimal("0.00"),
        "closing_value": Decimal("0.00"),
        "voucher_amount": Decimal("0.00"),
        "suppliers": 0,
        "customers": 0,
        "movements": 0,
    }


def add_party_summary(target, party, quantity, value, voucher_amount):
    row = target[party]
    row["party"] = party
    row["quantity"] = qty(row["quantity"] + quantity)
    row["value"] = money(row["value"] + value)
    row["voucher_amount"] = money(row["voucher_amount"] + voucher_amount)


def item_ledger(item_id, company_id=None, stock_book_id=None, date_from=None, date_to=None, highlight_id=None):
    if not item_id:
        return {"rows": [], "summary": empty_summary(), "supplier_rows": [], "customer_rows": []}

    entries = movement_query(item_id, company_id, stock_book_id, date_from, date_to).all()
    movements = grouped_movements(entries)
    if not movements:
        movements = source_line_movements(item_id, company_id, stock_book_id, date_from, date_to)
    running_qty = Decimal("0.000")
    running_value = Decimal("0.00")
    summary = empty_summary()
    supplier_totals = defaultdict(lambda: {"party": "", "quantity": Decimal("0.000"), "value": Decimal("0.00"), "voucher_amount": Decimal("0.00")})
    customer_totals = defaultdict(lambda: {"party": "", "quantity": Decimal("0.000"), "value": Decimal("0.00"), "voucher_amount": Decimal("0.00")})
    rows = []
    highlighted = False

    for group in movements:
        details = source_details(group)
        inward_qty = qty(group["quantity_in"])
        outward_qty = qty(group["quantity_out"])
        value = money(group["value"])
        inward_value = value if inward_qty > Decimal("0.000") else Decimal("0.00")
        outward_value = value if outward_qty > Decimal("0.000") else Decimal("0.00")
        running_qty = qty(running_qty + inward_qty - outward_qty)
        running_value = money(running_value + inward_value - outward_value)
        voucher_amount = money(details["voucher_amount"])
        is_current = bool(highlight_id and int(highlight_id) in group["ids"])
        if is_current:
            highlighted = True

        row = {
            **group,
            **details,
            "inward_qty": inward_qty,
            "outward_qty": outward_qty,
            "inward_value": inward_value,
            "outward_value": outward_value,
            "closing_qty": running_qty,
            "closing_value": running_value,
            "voucher_amount": voucher_amount,
            "is_current": is_current,
        }
        rows.append(row)
        summary["inward_qty"] = qty(summary["inward_qty"] + inward_qty)
        summary["outward_qty"] = qty(summary["outward_qty"] + outward_qty)
        summary["inward_value"] = money(summary["inward_value"] + inward_value)
        summary["outward_value"] = money(summary["outward_value"] + outward_value)
        summary["voucher_amount"] = money(summary["voucher_amount"] + voucher_amount)
        if details["party_kind"] == "Supplier":
            add_party_summary(supplier_totals, details["particulars"], inward_qty, inward_value, voucher_amount)
        if details["party_kind"] == "Debtor":
            add_party_summary(customer_totals, details["particulars"], outward_qty, outward_value, voucher_amount)

    if rows and not highlighted:
        rows[-1]["is_current"] = True

    summary["closing_qty"] = running_qty
    summary["closing_value"] = running_value
    summary["suppliers"] = len(supplier_totals)
    summary["customers"] = len(customer_totals)
    summary["movements"] = len(rows)
    return {
        "rows": rows,
        "summary": summary,
        "supplier_rows": sorted(supplier_totals.values(), key=lambda row: row["party"]),
        "customer_rows": sorted(customer_totals.values(), key=lambda row: row["party"]),
    }
