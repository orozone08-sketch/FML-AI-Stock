from datetime import datetime

from app.core.constants import PAYMENT_MODES, ROLE_ADMIN
from app.extensions import db
from app.models import (
    Company,
    Customer,
    Item,
    PaymentMode,
    StockBook,
    Supplier,
    User,
)
from app.services.audit import audit


def get_or_create(model, defaults=None, **kwargs):
    record = model.query.filter_by(**kwargs).first()
    if record:
        return record, False
    params = dict(kwargs)
    params.update(defaults or {})
    record = model(**params)
    db.session.add(record)
    return record, True


def seed_all(app):
    with app.app_context():
        seed_companies()
        seed_items()
        seed_suppliers()
        seed_customers()
        seed_payment_modes()
        seed_admin(app)
        db.session.commit()


def seed_companies():
    fml, _ = get_or_create(
        Company,
        code="FML",
        defaults={
            "name": "FirstTech Machine LLP",
            "allow_gst_purchase": True,
            "allow_cash_purchase": False,
            "allow_gst_sale": True,
            "allow_cash_sale": False,
            "active": True,
        },
    )
    ai, _ = get_or_create(
        Company,
        code="AI",
        defaults={
            "name": "Aditya International",
            "allow_gst_purchase": True,
            "allow_cash_purchase": True,
            "allow_gst_sale": True,
            "allow_cash_sale": True,
            "active": True,
        },
    )
    db.session.flush()
    books = [
        (fml, "FML_GST", "FML GST Stock", "GST", True),
        (ai, "AI_GST", "AI GST Stock", "GST", True),
        (ai, "AI_CASH", "AI Cash Stock", "CASH", True),
        (fml, "FML_CASH", "FML Cash Stock", "CASH", False),
    ]
    for company, code, name, book_type, active in books:
        get_or_create(
            StockBook,
            code=code,
            defaults={
                "company_id": company.id,
                "name": name,
                "book_type": book_type,
                "active": active,
            },
        )


def seed_items():
    rows = [
        ("1", "FF510 Red Wax 1.5kg", "kg", "18.00", "2.000"),
        ("2", "FF510 Support Wax 1.5kg", "kg", "18.00", "2.000"),
        ("3", "FF530 Red Wax 3kg", "kg", "18.00", "2.000"),
    ]
    for code, name, unit, gst, minimum in rows:
        get_or_create(
            Item,
            code=code,
            defaults={
                "name": name,
                "unit": unit,
                "gst_percent": gst,
                "minimum_stock": minimum,
                "active": True,
            },
        )


def seed_suppliers():
    rows = [
        ("NC", "Navbharat Carbon Company"),
        ("DD", "DOIT DIGIFABB INDIA PVT LTD"),
        ("CS", "Cascade Star India Pvt Ltd"),
    ]
    for code, name in rows:
        get_or_create(Supplier, code=code, defaults={"name": name, "active": True})


def seed_customers():
    cash = [
        "As Technology (Amarjit)",
        "Am Jewellers",
        "Sarkar Casting",
        "Dalim Khan",
        "SK Samim",
        "Pawan Gurjar",
        "Suvarnkriti",
        "Krishna Production",
        "Sanjay Jana",
        "Arpit Agrawal",
        "Suman Cad Cam",
        "Jiyan Casting",
        "Piku Bera",
        "NR Cad Cam",
        "Pankaj Yadav (M Tech Enterprises)",
        "Tejasri Enterprises (Durgaprasad SRT)",
        "Laxmi Mata 3d Cam",
        "Mofiza Jewellery (Tausif)",
        "Dua Gold (Swaroop)",
        "Sangita Casting",
    ]
    bill = [
        "Shreenath Ornament (Pawan Shrinath)",
        "RB Ornaments",
        "3d Cam (Swarup)",
        "Alok Dolvi",
        "ANKITST JEWELLERY TOOLS AND MACHINERIES (HYDERABAD)",
        "Jewelstar Cam Service",
        "Radhakrishna Jewellers",
        "Dream INNOVATION (Shashikant)",
        "Ace cad cam (Shivam Chavan)",
        "Crown 3d (Rajan)",
    ]
    for index, name in enumerate(cash, start=1):
        get_or_create(
            Customer,
            code=f"CASH{index:03d}",
            defaults={
                "name": name,
                "customer_type": "CASH",
                "default_credit_days": 0,
                "active": True,
            },
        )
    for index, name in enumerate(bill, start=1):
        get_or_create(
            Customer,
            code=f"BILL{index:03d}",
            defaults={
                "name": name,
                "customer_type": "CASH_AND_BILL",
                "default_credit_days": 30,
                "active": True,
            },
        )


def seed_payment_modes():
    for mode in PAYMENT_MODES:
        get_or_create(PaymentMode, code=mode, defaults={"name": mode.title(), "active": True})


def seed_admin(app):
    admin, created = get_or_create(
        User,
        email=app.config["ADMIN_EMAIL"].lower(),
        defaults={
            "name": app.config["ADMIN_NAME"],
            "role": ROLE_ADMIN,
            "active": True,
            "password_hash": "placeholder",
        },
    )
    if created or admin.password_hash == "placeholder":
        admin.set_password(app.config["ADMIN_PASSWORD"])
        admin.last_login_at = None
        audit(
            "seed_admin",
            "User",
            reference=admin.email,
            after={"email": admin.email, "role": admin.role, "seeded_at": datetime.utcnow()},
            user=admin,
        )
