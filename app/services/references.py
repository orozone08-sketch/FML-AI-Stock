from datetime import date

from app.extensions import db
from app.models import (
    InterCompanyTransfer,
    OpeningStock,
    Purchase,
    Sale,
)


REFERENCE_MODELS = {
    "purchase": (Purchase, Purchase.bill_number, "PUR"),
    "sale": (Sale, Sale.invoice_number, "INV"),
    "transfer": (InterCompanyTransfer, InterCompanyTransfer.reference_number, "TRF"),
    "opening_stock": (OpeningStock, OpeningStock.reference_number, "OPN-STK"),
}


def next_reference(kind):
    model, field, prefix = REFERENCE_MODELS[kind]
    today = date.today()
    stem = f"{prefix}-{today:%Y%m%d}-"
    last = (
        db.session.query(field)
        .filter(field.like(stem + "%"))
        .order_by(field.desc())
        .first()
    )
    number = 1
    if last:
        try:
            number = int(last[0].split("-")[-1]) + 1
        except (ValueError, IndexError):
            number = 1
    return f"{stem}{number:04d}"
