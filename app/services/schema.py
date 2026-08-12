from sqlalchemy import Index, inspect, text

from app.extensions import db
from app.models import Customer, normalize_customer_name


def ensure_runtime_schema():
    """Apply small additive schema upgrades for existing Docker databases."""
    inspector = inspect(db.engine)
    if inspector.has_table("user"):
        ensure_columns(
            "user",
            {
                "company_id": "INTEGER NULL",
            },
            inspector,
        )
    if inspector.has_table("customer"):
        ensure_columns(
            "customer",
            {
                "contact_person": "VARCHAR(160) NULL",
                "whatsapp": "VARCHAR(40) NULL",
                "city": "VARCHAR(120) NULL",
                "state": "VARCHAR(120) NULL",
                "name_key": "VARCHAR(255) NULL",
                "edit_version": "INTEGER NOT NULL DEFAULT 1",
            },
            inspector,
        )
        backfill_customer_name_keys()
        ensure_customer_name_key_index()


def backfill_customer_name_keys():
    """Backfill legacy customers without breaking their historical links.

    Existing duplicate names are retained with a legacy suffix so deployment
    never silently merges financial history. New and edited records use the
    normalized name and are protected by the unique index.
    """
    customers = Customer.query.order_by(Customer.id).all()
    seen = set()
    changed = False
    for customer in customers:
        base = normalize_customer_name(customer.name) or f"__legacy_customer_{customer.id}"
        key = base
        if key in seen:
            key = f"{base}#legacy-{customer.id}"
        seen.add(key)
        if customer.name_key != key:
            customer.name_key = key
            changed = True
    if changed:
        db.session.commit()


def ensure_customer_name_key_index():
    inspector = inspect(db.engine)
    has_unique_constraint = any(
        constraint.get("unique") and constraint.get("column_names") == ["name_key"]
        for constraint in inspector.get_unique_constraints("customer")
    )
    has_unique_index = any(
        index.get("unique") and index.get("column_names") == ["name_key"]
        for index in inspector.get_indexes("customer")
    )
    if not has_unique_constraint and not has_unique_index:
        Index("uq_customer_name_key", Customer.name_key, unique=True).create(
            bind=db.engine, checkfirst=True
        )


def ensure_columns(table, columns, inspector):
    existing = {column["name"] for column in inspector.get_columns(table)}
    missing = {name: definition for name, definition in columns.items() if name not in existing}
    if not missing:
        return
    table_name = db.engine.dialect.identifier_preparer.quote(table)
    with db.engine.begin() as connection:
        for name, definition in missing.items():
            column_name = db.engine.dialect.identifier_preparer.quote(name)
            connection.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"))
