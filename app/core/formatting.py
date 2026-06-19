from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


MONEY_ZERO = Decimal("0.00")
QTY_ZERO = Decimal("0.000")


def dec(value, default="0"):
    if value is None or value == "":
        return Decimal(default)
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, AttributeError):
        raise ValueError("Invalid decimal value")


def money(value):
    return dec(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def qty(value):
    return dec(value).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)


def positive_money(value, label):
    amount = money(value)
    if amount <= MONEY_ZERO:
        raise ValueError(f"{label} must be greater than zero.")
    return amount


def positive_qty(value, label="Quantity"):
    quantity = qty(value)
    if quantity <= QTY_ZERO:
        raise ValueError(f"{label} must be greater than zero.")
    return quantity


def fmt_money(value):
    amount = money(value)
    sign = "-" if amount < 0 else ""
    raw = f"{abs(amount):.2f}"
    whole, fraction = raw.split(".")
    if len(whole) > 3:
        last = whole[-3:]
        leading = whole[:-3]
        parts = []
        while len(leading) > 2:
            parts.insert(0, leading[-2:])
            leading = leading[:-2]
        if leading:
            parts.insert(0, leading)
        whole = ",".join(parts + [last])
    return f"{sign}₹{whole}.{fraction}"


def fmt_qty(value):
    quantity = qty(value)
    text = f"{quantity:.3f}".rstrip("0").rstrip(".")
    return text or "0"


def payment_status(total, paid):
    total = money(total)
    paid = money(paid)
    balance = money(total - paid)
    if balance <= MONEY_ZERO:
        return "PAID"
    if paid <= MONEY_ZERO:
        return "UNPAID"
    return "PARTIAL"
