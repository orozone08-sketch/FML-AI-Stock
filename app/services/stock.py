from decimal import Decimal

from app.core.formatting import money, qty
from app.extensions import db
from app.models import FIFOLayer, FIFOConsumption, StockLedgerEntry


def layer_status(layer):
    if qty(layer.available_quantity) <= Decimal("0.000"):
        return "CONSUMED"
    if qty(layer.available_quantity) < qty(layer.original_quantity):
        return "PARTIAL"
    return "OPEN"


def create_fifo_layer(
    company_id,
    stock_book_id,
    item_id,
    source_type,
    source_id,
    source_line_id,
    source_reference,
    source_date,
    quantity,
    unit_cost,
    user_id=None,
):
    quantity = qty(quantity)
    unit_cost = Decimal(unit_cost)
    value = money(quantity * unit_cost)
    layer = FIFOLayer(
        company_id=company_id,
        stock_book_id=stock_book_id,
        item_id=item_id,
        source_type=source_type,
        source_id=source_id,
        source_line_id=source_line_id,
        source_reference=source_reference,
        source_date=source_date,
        original_quantity=quantity,
        available_quantity=quantity,
        unit_cost=unit_cost,
        original_value=value,
        available_value=value,
        status="OPEN",
        created_by_id=user_id,
    )
    db.session.add(layer)
    return layer


def stock_ledger(
    company_id,
    stock_book_id,
    item_id,
    entry_date,
    movement_type,
    transaction_type,
    transaction_id,
    reference_number,
    quantity,
    rate,
    remarks=None,
    user_id=None,
):
    quantity = qty(quantity)
    rate = Decimal(rate)
    value = money(quantity * rate)
    entry = StockLedgerEntry(
        company_id=company_id,
        stock_book_id=stock_book_id,
        item_id=item_id,
        entry_date=entry_date,
        movement_type=movement_type,
        transaction_type=transaction_type,
        transaction_id=transaction_id,
        reference_number=reference_number,
        quantity_in=quantity if movement_type == "IN" else Decimal("0.000"),
        quantity_out=quantity if movement_type == "OUT" else Decimal("0.000"),
        rate=rate,
        value=value,
        remarks=remarks,
        created_by_id=user_id,
    )
    db.session.add(entry)
    return entry


def current_stock(company_id=None, stock_book_id=None, item_id=None):
    query = db.session.query(
        FIFOLayer.company_id,
        FIFOLayer.stock_book_id,
        FIFOLayer.item_id,
        db.func.coalesce(db.func.sum(FIFOLayer.available_quantity), 0).label("quantity"),
        db.func.coalesce(db.func.sum(FIFOLayer.available_value), 0).label("value"),
    ).filter(FIFOLayer.available_quantity > 0)
    if company_id:
        query = query.filter(FIFOLayer.company_id == company_id)
    if stock_book_id:
        query = query.filter(FIFOLayer.stock_book_id == stock_book_id)
    if item_id:
        query = query.filter(FIFOLayer.item_id == item_id)
    return query.group_by(
        FIFOLayer.company_id, FIFOLayer.stock_book_id, FIFOLayer.item_id
    ).all()


def available_quantity(company_id, stock_book_id, item_id):
    value = (
        db.session.query(db.func.coalesce(db.func.sum(FIFOLayer.available_quantity), 0))
        .filter(
            FIFOLayer.company_id == company_id,
            FIFOLayer.stock_book_id == stock_book_id,
            FIFOLayer.item_id == item_id,
            FIFOLayer.available_quantity > 0,
        )
        .scalar()
    )
    return qty(value)


def consume_fifo(
    company_id,
    stock_book_id,
    item_id,
    required_quantity,
    source_type,
    source_id,
    source_line_id,
):
    required_quantity = qty(required_quantity)
    remaining = required_quantity
    layers = (
        FIFOLayer.query.filter(
            FIFOLayer.company_id == company_id,
            FIFOLayer.stock_book_id == stock_book_id,
            FIFOLayer.item_id == item_id,
            FIFOLayer.available_quantity > 0,
        )
        .order_by(FIFOLayer.source_date.asc(), FIFOLayer.id.asc())
        .with_for_update()
        .all()
    )
    total_available = qty(sum((layer.available_quantity for layer in layers), Decimal("0.000")))
    if total_available < required_quantity:
        raise ValueError(
            f"Insufficient stock. Available: {total_available}; requested: {required_quantity}."
        )

    consumptions = []
    for layer in layers:
        if remaining <= Decimal("0.000"):
            break
        take = min(qty(layer.available_quantity), remaining)
        value = money(take * layer.unit_cost)
        layer.available_quantity = qty(layer.available_quantity - take)
        layer.available_value = money(layer.available_quantity * layer.unit_cost)
        layer.status = layer_status(layer)
        consumption = FIFOConsumption(
            fifo_layer_id=layer.id,
            source_type=source_type,
            source_id=source_id,
            source_line_id=source_line_id,
            quantity=take,
            rate=layer.unit_cost,
            value=value,
        )
        db.session.add(consumption)
        consumptions.append((layer, consumption))
        remaining = qty(remaining - take)

    return consumptions
