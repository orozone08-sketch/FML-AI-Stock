from datetime import datetime
from decimal import Decimal

from flask_login import UserMixin
from werkzeug.security import check_password_hash, generate_password_hash

from app.extensions import db, login_manager


class TimestampMixin:
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(
        db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    created_by_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    updated_by_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)


class User(UserMixin, TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(255), nullable=False, unique=True, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(30), nullable=False, default="VIEWER", index=True)
    active = db.Column(db.Boolean, nullable=False, default=True)
    last_login_at = db.Column(db.DateTime, nullable=True)
    force_password_change = db.Column(db.Boolean, nullable=False, default=False)

    permission_overrides = db.relationship(
        "PermissionOverride", back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def is_active(self):
        return self.active

    def set_password(self, password):
        self.password_hash = generate_password_hash(password, method="pbkdf2:sha256", salt_length=16)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


class PermissionOverride(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False, index=True)
    module = db.Column(db.String(80), nullable=False, index=True)
    can_view = db.Column(db.Boolean, nullable=True)
    can_create = db.Column(db.Boolean, nullable=True)
    can_edit = db.Column(db.Boolean, nullable=True)
    can_approve = db.Column(db.Boolean, nullable=True)
    can_export = db.Column(db.Boolean, nullable=True)
    can_deactivate = db.Column(db.Boolean, nullable=True)

    user = db.relationship("User", back_populates="permission_overrides")

    __table_args__ = (db.UniqueConstraint("user_id", "module", name="uq_user_module"),)


class Company(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(160), nullable=False)
    code = db.Column(db.String(20), nullable=False, unique=True, index=True)
    gst_number = db.Column(db.String(40), nullable=True)
    allow_gst_purchase = db.Column(db.Boolean, nullable=False, default=True)
    allow_cash_purchase = db.Column(db.Boolean, nullable=False, default=False)
    allow_gst_sale = db.Column(db.Boolean, nullable=False, default=True)
    allow_cash_sale = db.Column(db.Boolean, nullable=False, default=False)
    active = db.Column(db.Boolean, nullable=False, default=True)

    stock_books = db.relationship("StockBook", back_populates="company")


class StockBook(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    name = db.Column(db.String(160), nullable=False)
    code = db.Column(db.String(40), nullable=False, unique=True, index=True)
    book_type = db.Column(db.String(20), nullable=False)
    active = db.Column(db.Boolean, nullable=False, default=True)

    company = db.relationship("Company", back_populates="stock_books")


class Item(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(50), nullable=False, unique=True, index=True)
    name = db.Column(db.String(200), nullable=False)
    unit = db.Column(db.String(30), nullable=False, default="pcs")
    hsn = db.Column(db.String(40), nullable=True)
    gst_percent = db.Column(db.Numeric(8, 2), nullable=False, default=Decimal("0.00"))
    minimum_stock = db.Column(db.Numeric(18, 3), nullable=False, default=Decimal("0.000"))
    active = db.Column(db.Boolean, nullable=False, default=True)
    notes = db.Column(db.Text, nullable=True)

    @property
    def display_name(self):
        return f"{self.code} - {self.name} ({self.unit})"


class Supplier(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(50), nullable=False, unique=True, index=True)
    name = db.Column(db.String(220), nullable=False)
    gst_number = db.Column(db.String(40), nullable=True)
    mobile = db.Column(db.String(40), nullable=True)
    email = db.Column(db.String(255), nullable=True)
    address = db.Column(db.Text, nullable=True)
    default_credit_days = db.Column(db.Integer, nullable=False, default=30)
    active = db.Column(db.Boolean, nullable=False, default=True)


class Customer(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(50), nullable=False, unique=True, index=True)
    name = db.Column(db.String(220), nullable=False)
    customer_type = db.Column(db.String(30), nullable=False, default="CASH_AND_BILL")
    gst_number = db.Column(db.String(40), nullable=True)
    mobile = db.Column(db.String(40), nullable=True)
    email = db.Column(db.String(255), nullable=True)
    address = db.Column(db.Text, nullable=True)
    default_credit_days = db.Column(db.Integer, nullable=False, default=30)
    active = db.Column(db.Boolean, nullable=False, default=True)
    notes = db.Column(db.Text, nullable=True)


class PaymentMode(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(30), nullable=False, unique=True)
    name = db.Column(db.String(80), nullable=False)
    active = db.Column(db.Boolean, nullable=False, default=True)


class OpeningStock(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=False)
    reference_number = db.Column(db.String(80), nullable=False, index=True)
    opening_date = db.Column(db.Date, nullable=False, index=True)
    remarks = db.Column(db.Text, nullable=True)
    is_void = db.Column(db.Boolean, nullable=False, default=False)

    company = db.relationship("Company")
    stock_book = db.relationship("StockBook")
    lines = db.relationship("OpeningStockLine", back_populates="opening_stock")


class OpeningStockLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    opening_stock_id = db.Column(
        db.Integer, db.ForeignKey("opening_stock.id"), nullable=False
    )
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=False)
    quantity = db.Column(db.Numeric(18, 3), nullable=False)
    rate = db.Column(db.Numeric(18, 4), nullable=False)
    value = db.Column(db.Numeric(18, 2), nullable=False)
    remarks = db.Column(db.Text, nullable=True)

    opening_stock = db.relationship("OpeningStock", back_populates="lines")
    item = db.relationship("Item")


class Purchase(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=False)
    supplier_id = db.Column(db.Integer, db.ForeignKey("supplier.id"), nullable=False)
    purchase_type = db.Column(db.String(20), nullable=False)
    bill_number = db.Column(db.String(80), nullable=False)
    bill_date = db.Column(db.Date, nullable=False, index=True)
    due_date = db.Column(db.Date, nullable=True, index=True)
    subtotal = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    gst_total = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    grand_total = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    paid_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    balance_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    payment_status = db.Column(db.String(20), nullable=False, default="UNPAID")
    remarks = db.Column(db.Text, nullable=True)
    is_opening = db.Column(db.Boolean, nullable=False, default=False)
    is_void = db.Column(db.Boolean, nullable=False, default=False)

    company = db.relationship("Company")
    stock_book = db.relationship("StockBook")
    supplier = db.relationship("Supplier")
    lines = db.relationship("PurchaseLine", back_populates="purchase")

    __table_args__ = (
        db.UniqueConstraint(
            "company_id", "supplier_id", "bill_number", name="uq_purchase_company_supplier_bill"
        ),
    )


class PurchaseLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    purchase_id = db.Column(db.Integer, db.ForeignKey("purchase.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=False)
    quantity = db.Column(db.Numeric(18, 3), nullable=False)
    rate = db.Column(db.Numeric(18, 4), nullable=False)
    gst_percent = db.Column(db.Numeric(8, 2), nullable=False, default=Decimal("0.00"))
    subtotal = db.Column(db.Numeric(18, 2), nullable=False)
    gst_amount = db.Column(db.Numeric(18, 2), nullable=False)
    line_total = db.Column(db.Numeric(18, 2), nullable=False)

    purchase = db.relationship("Purchase", back_populates="lines")
    item = db.relationship("Item")


class Sale(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=False)
    customer_id = db.Column(db.Integer, db.ForeignKey("customer.id"), nullable=False)
    sale_type = db.Column(db.String(20), nullable=False)
    invoice_number = db.Column(db.String(80), nullable=False)
    invoice_date = db.Column(db.Date, nullable=False, index=True)
    due_date = db.Column(db.Date, nullable=True, index=True)
    subtotal = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    gst_total = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    grand_total = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    fifo_cost = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    gross_profit = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    paid_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    balance_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    payment_status = db.Column(db.String(20), nullable=False, default="UNPAID")
    remarks = db.Column(db.Text, nullable=True)
    is_opening = db.Column(db.Boolean, nullable=False, default=False)
    is_void = db.Column(db.Boolean, nullable=False, default=False)

    company = db.relationship("Company")
    stock_book = db.relationship("StockBook")
    customer = db.relationship("Customer")
    lines = db.relationship("SaleLine", back_populates="sale")

    __table_args__ = (
        db.UniqueConstraint("company_id", "invoice_number", name="uq_sale_company_invoice"),
    )


class SaleLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sale_id = db.Column(db.Integer, db.ForeignKey("sale.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=False)
    quantity = db.Column(db.Numeric(18, 3), nullable=False)
    sale_rate = db.Column(db.Numeric(18, 4), nullable=False)
    gst_percent = db.Column(db.Numeric(8, 2), nullable=False, default=Decimal("0.00"))
    subtotal = db.Column(db.Numeric(18, 2), nullable=False)
    gst_amount = db.Column(db.Numeric(18, 2), nullable=False)
    line_total = db.Column(db.Numeric(18, 2), nullable=False)
    fifo_cost = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    gross_profit = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))

    sale = db.relationship("Sale", back_populates="lines")
    item = db.relationship("Item")


class InterCompanyTransfer(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    from_company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    from_stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=False)
    to_company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    to_stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=False)
    reference_number = db.Column(db.String(80), nullable=False, unique=True)
    transfer_date = db.Column(db.Date, nullable=False, index=True)
    reason = db.Column(db.String(220), nullable=True)
    remarks = db.Column(db.Text, nullable=True)
    total_fifo_value = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    mismatch_approved = db.Column(db.Boolean, nullable=False, default=False)
    approval_reason = db.Column(db.Text, nullable=True)
    approved_by_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    approved_at = db.Column(db.DateTime, nullable=True)
    is_void = db.Column(db.Boolean, nullable=False, default=False)

    from_company = db.relationship("Company", foreign_keys=[from_company_id])
    to_company = db.relationship("Company", foreign_keys=[to_company_id])
    from_stock_book = db.relationship("StockBook", foreign_keys=[from_stock_book_id])
    to_stock_book = db.relationship("StockBook", foreign_keys=[to_stock_book_id])
    lines = db.relationship("TransferLine", back_populates="transfer")


class TransferLine(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    transfer_id = db.Column(
        db.Integer, db.ForeignKey("inter_company_transfer.id"), nullable=False
    )
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=False)
    quantity = db.Column(db.Numeric(18, 3), nullable=False)
    fifo_value = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))

    transfer = db.relationship("InterCompanyTransfer", back_populates="lines")
    item = db.relationship("Item")


class FIFOLayer(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=False)
    source_type = db.Column(db.String(40), nullable=False)
    source_id = db.Column(db.Integer, nullable=False)
    source_line_id = db.Column(db.Integer, nullable=True)
    source_reference = db.Column(db.String(100), nullable=False)
    source_date = db.Column(db.Date, nullable=False, index=True)
    original_quantity = db.Column(db.Numeric(18, 3), nullable=False)
    available_quantity = db.Column(db.Numeric(18, 3), nullable=False)
    unit_cost = db.Column(db.Numeric(18, 4), nullable=False)
    original_value = db.Column(db.Numeric(18, 2), nullable=False)
    available_value = db.Column(db.Numeric(18, 2), nullable=False)
    status = db.Column(db.String(20), nullable=False, default="OPEN")

    company = db.relationship("Company")
    stock_book = db.relationship("StockBook")
    item = db.relationship("Item")


class FIFOConsumption(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    fifo_layer_id = db.Column(db.Integer, db.ForeignKey("fifo_layer.id"), nullable=False)
    source_type = db.Column(db.String(40), nullable=False)
    source_id = db.Column(db.Integer, nullable=False)
    source_line_id = db.Column(db.Integer, nullable=True)
    quantity = db.Column(db.Numeric(18, 3), nullable=False)
    rate = db.Column(db.Numeric(18, 4), nullable=False)
    value = db.Column(db.Numeric(18, 2), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    fifo_layer = db.relationship("FIFOLayer")


class StockLedgerEntry(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=False)
    entry_date = db.Column(db.Date, nullable=False, index=True)
    movement_type = db.Column(db.String(10), nullable=False)
    transaction_type = db.Column(db.String(40), nullable=False)
    transaction_id = db.Column(db.Integer, nullable=False)
    reference_number = db.Column(db.String(100), nullable=False)
    quantity_in = db.Column(db.Numeric(18, 3), nullable=False, default=Decimal("0.000"))
    quantity_out = db.Column(db.Numeric(18, 3), nullable=False, default=Decimal("0.000"))
    rate = db.Column(db.Numeric(18, 4), nullable=False, default=Decimal("0.0000"))
    value = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    remarks = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    created_by_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)

    company = db.relationship("Company")
    stock_book = db.relationship("StockBook")
    item = db.relationship("Item")


class Receivable(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=True)
    customer_id = db.Column(db.Integer, db.ForeignKey("customer.id"), nullable=True)
    counterparty_company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=True)
    source_type = db.Column(db.String(40), nullable=False)
    source_id = db.Column(db.Integer, nullable=False)
    document_number = db.Column(db.String(100), nullable=False)
    document_date = db.Column(db.Date, nullable=False, index=True)
    due_date = db.Column(db.Date, nullable=True, index=True)
    transaction_type = db.Column(db.String(20), nullable=True)
    total_amount = db.Column(db.Numeric(18, 2), nullable=False)
    paid_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    balance_amount = db.Column(db.Numeric(18, 2), nullable=False)
    payment_status = db.Column(db.String(20), nullable=False, default="UNPAID")
    remarks = db.Column(db.Text, nullable=True)
    is_opening = db.Column(db.Boolean, nullable=False, default=False)

    company = db.relationship("Company", foreign_keys=[company_id])
    customer = db.relationship("Customer")
    counterparty_company = db.relationship("Company", foreign_keys=[counterparty_company_id])


class Payable(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey("supplier.id"), nullable=True)
    counterparty_company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=True)
    source_type = db.Column(db.String(40), nullable=False)
    source_id = db.Column(db.Integer, nullable=False)
    document_number = db.Column(db.String(100), nullable=False)
    document_date = db.Column(db.Date, nullable=False, index=True)
    due_date = db.Column(db.Date, nullable=True, index=True)
    transaction_type = db.Column(db.String(20), nullable=True)
    total_amount = db.Column(db.Numeric(18, 2), nullable=False)
    paid_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    balance_amount = db.Column(db.Numeric(18, 2), nullable=False)
    payment_status = db.Column(db.String(20), nullable=False, default="UNPAID")
    remarks = db.Column(db.Text, nullable=True)
    is_opening = db.Column(db.Boolean, nullable=False, default=False)

    company = db.relationship("Company", foreign_keys=[company_id])
    supplier = db.relationship("Supplier")
    counterparty_company = db.relationship("Company", foreign_keys=[counterparty_company_id])


class Payment(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    payment_type = db.Column(db.String(40), nullable=False)
    party_type = db.Column(db.String(40), nullable=False)
    customer_id = db.Column(db.Integer, db.ForeignKey("customer.id"), nullable=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey("supplier.id"), nullable=True)
    payment_date = db.Column(db.Date, nullable=False, index=True)
    mode = db.Column(db.String(30), nullable=False)
    reference_number = db.Column(db.String(100), nullable=True)
    total_amount = db.Column(db.Numeric(18, 2), nullable=False)
    allocated_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    unallocated_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    remarks = db.Column(db.Text, nullable=True)

    company = db.relationship("Company")
    customer = db.relationship("Customer")
    supplier = db.relationship("Supplier")
    allocations = db.relationship("PaymentAllocation", back_populates="payment")


class PaymentAllocation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    payment_id = db.Column(db.Integer, db.ForeignKey("payment.id"), nullable=False)
    target_type = db.Column(db.String(40), nullable=False)
    target_id = db.Column(db.Integer, nullable=False)
    amount = db.Column(db.Numeric(18, 2), nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    payment = db.relationship("Payment", back_populates="allocations")


class InterCompanyLedgerEntry(TimestampMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    stock_owner_company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    stock_user_company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=False)
    transfer_id = db.Column(
        db.Integer, db.ForeignKey("inter_company_transfer.id"), nullable=False
    )
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=True)
    quantity = db.Column(db.Numeric(18, 3), nullable=False, default=Decimal("0.000"))
    amount_owed = db.Column(db.Numeric(18, 2), nullable=False)
    settled_amount = db.Column(db.Numeric(18, 2), nullable=False, default=Decimal("0.00"))
    balance_amount = db.Column(db.Numeric(18, 2), nullable=False)
    due_date = db.Column(db.Date, nullable=True)
    status = db.Column(db.String(20), nullable=False, default="UNPAID")

    owner_company = db.relationship("Company", foreign_keys=[stock_owner_company_id])
    user_company = db.relationship("Company", foreign_keys=[stock_user_company_id])
    transfer = db.relationship("InterCompanyTransfer")
    item = db.relationship("Item")


class AuditLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)
    action = db.Column(db.String(80), nullable=False)
    entity_type = db.Column(db.String(80), nullable=False)
    entity_id = db.Column(db.String(80), nullable=True)
    reference = db.Column(db.String(120), nullable=True)
    before_values = db.Column(db.Text, nullable=True)
    after_values = db.Column(db.Text, nullable=True)
    approval_reason = db.Column(db.Text, nullable=True)
    ip_address = db.Column(db.String(80), nullable=True)
    user_agent = db.Column(db.String(255), nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, index=True)

    user = db.relationship("User")


class Alert(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    alert_type = db.Column(db.String(50), nullable=False)
    severity = db.Column(db.String(30), nullable=False)
    company_id = db.Column(db.Integer, db.ForeignKey("company.id"), nullable=True)
    stock_book_id = db.Column(db.Integer, db.ForeignKey("stock_book.id"), nullable=True)
    item_id = db.Column(db.Integer, db.ForeignKey("item.id"), nullable=True)
    message = db.Column(db.String(255), nullable=False)
    resolved = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    company = db.relationship("Company")
    stock_book = db.relationship("StockBook")
    item = db.relationship("Item")
