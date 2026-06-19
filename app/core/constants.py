ROLE_ADMIN = "ADMIN"
ROLE_STOCK = "STOCK"
ROLE_SALES = "SALES"
ROLE_ACCOUNTS = "ACCOUNTS"
ROLE_VIEWER = "VIEWER"

ROLES = [ROLE_ADMIN, ROLE_STOCK, ROLE_SALES, ROLE_ACCOUNTS, ROLE_VIEWER]

STOCK_BOOK_GST = "GST"
STOCK_BOOK_CASH = "CASH"
STOCK_BOOK_TYPES = [STOCK_BOOK_GST, STOCK_BOOK_CASH]

PAYMENT_MODES = ["CASH", "BANK", "UPI", "CHEQUE", "RTGS", "NEFT", "OTHER"]

PAYMENT_STATUS_UNPAID = "UNPAID"
PAYMENT_STATUS_PARTIAL = "PARTIAL"
PAYMENT_STATUS_PAID = "PAID"
PAYMENT_STATUS_ADVANCE = "ADVANCE"

FIFO_STATUS_OPEN = "OPEN"
FIFO_STATUS_PARTIAL = "PARTIAL"
FIFO_STATUS_CONSUMED = "CONSUMED"

MODULES = [
    "dashboard",
    "items",
    "customers",
    "suppliers",
    "companies",
    "stock_books",
    "purchase",
    "sale",
    "transfer",
    "opening",
    "payments",
    "outstanding",
    "due_alerts",
    "stock",
    "inter_company",
    "reports",
    "users",
    "audit",
]

ROLE_PERMISSIONS = {
    ROLE_ADMIN: {
        module: {"view", "create", "edit", "approve", "export", "deactivate"}
        for module in MODULES
    },
    ROLE_STOCK: {
        "dashboard": {"view"},
        "items": {"view", "create", "edit", "deactivate"},
        "suppliers": {"view", "create", "edit", "deactivate"},
        "customers": {"view"},
        "companies": {"view"},
        "stock_books": {"view"},
        "purchase": {"view", "create", "export"},
        "sale": {"view"},
        "transfer": {"view", "create", "approve", "export"},
        "opening": {"view", "create"},
        "payments": set(),
        "outstanding": {"view"},
        "due_alerts": {"view"},
        "stock": {"view", "export"},
        "inter_company": {"view", "export"},
        "reports": {"view", "export"},
        "users": set(),
        "audit": {"view"},
    },
    ROLE_SALES: {
        "dashboard": {"view"},
        "items": {"view"},
        "suppliers": {"view"},
        "customers": {"view", "create", "edit"},
        "companies": {"view"},
        "stock_books": {"view"},
        "purchase": {"view"},
        "sale": {"view", "create", "export"},
        "transfer": {"view"},
        "opening": set(),
        "payments": {"view", "create"},
        "outstanding": {"view", "export"},
        "due_alerts": {"view"},
        "stock": {"view"},
        "inter_company": {"view"},
        "reports": {"view", "export"},
        "users": set(),
        "audit": set(),
    },
    ROLE_ACCOUNTS: {
        "dashboard": {"view"},
        "items": {"view"},
        "suppliers": {"view"},
        "customers": {"view"},
        "companies": {"view"},
        "stock_books": {"view"},
        "purchase": {"view"},
        "sale": {"view"},
        "transfer": {"view"},
        "opening": {"view", "create"},
        "payments": {"view", "create", "export"},
        "outstanding": {"view", "export"},
        "due_alerts": {"view"},
        "stock": {"view"},
        "inter_company": {"view", "export"},
        "reports": {"view", "export"},
        "users": set(),
        "audit": {"view"},
    },
    ROLE_VIEWER: {
        "dashboard": {"view"},
        "items": {"view"},
        "suppliers": {"view"},
        "customers": {"view"},
        "companies": {"view"},
        "stock_books": {"view"},
        "purchase": {"view"},
        "sale": {"view"},
        "transfer": {"view"},
        "opening": {"view"},
        "payments": {"view"},
        "outstanding": {"view"},
        "due_alerts": {"view"},
        "stock": {"view"},
        "inter_company": {"view"},
        "reports": {"view"},
        "users": set(),
        "audit": set(),
    },
}
