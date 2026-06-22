from flask import session

from app.models import Company


ACTIVE_COMPANY_SESSION_KEY = "active_company_id"
COMPANY_LOGOS = {
    "FML": "img/firsttech-logo.jpg",
    "AI": "img/aditya-logo.jpg",
}
COMPANY_ORDER = {"FML": 0, "AI": 1}
COMPANY_THEMES = {
    "FML": {
        "body_class": "theme-firsttech",
        "app_name": "FirstTech Machine LLP",
        "tagline": "Next generation technology stock control",
    },
    "AI": {
        "body_class": "theme-aditya",
        "app_name": "Aditya International",
        "tagline": "Jewellery factory supplies stock control",
    },
}
USER_COMPANY_CODES = {
    "firsttech.user": "FML",
    "adityainternational.user": "AI",
}


def company_choices():
    companies = Company.query.filter_by(active=True).all()
    return sorted(companies, key=lambda company: (COMPANY_ORDER.get(company.code, 99), company.name))


def company_logo(company):
    return COMPANY_LOGOS.get(company.code, "img/fastockflow-icon.png")


def company_theme(company):
    if not company:
        return {
            "body_class": "theme-default",
            "app_name": "Company Login",
            "tagline": "Select FirstTech or Aditya to continue",
        }
    return COMPANY_THEMES.get(company.code, COMPANY_THEMES["AI"])


def active_company():
    company_id = session.get(ACTIVE_COMPANY_SESSION_KEY)
    if not company_id:
        return None
    company = Company.query.filter_by(id=company_id, active=True).first()
    if not company:
        session.pop(ACTIVE_COMPANY_SESSION_KEY, None)
    return company


def other_company(company=None):
    company = company or active_company()
    if not company:
        return None
    return next((choice for choice in company_choices() if choice.id != company.id), None)


def set_active_company(company_id):
    company = Company.query.filter_by(id=int(company_id or 0), active=True).first()
    if not company:
        return None
    session[ACTIVE_COMPANY_SESSION_KEY] = company.id
    return company


def set_active_company_for_user(user):
    code = USER_COMPANY_CODES.get((getattr(user, "email", "") or "").strip().lower())
    if not code:
        return None
    company = Company.query.filter_by(code=code, active=True).first()
    if not company:
        return None
    session[ACTIVE_COMPANY_SESSION_KEY] = company.id
    return company


def user_has_fixed_company(user):
    return (getattr(user, "email", "") or "").strip().lower() in USER_COMPANY_CODES


def clear_active_company():
    session.pop(ACTIVE_COMPANY_SESSION_KEY, None)
