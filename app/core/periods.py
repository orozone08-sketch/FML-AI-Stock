from datetime import date, datetime


def financial_year_start(today=None):
    today = today or date.today()
    year = today.year if today.month >= 4 else today.year - 1
    return date(year, 4, 1)


def current_financial_year_period(today=None):
    today = today or date.today()
    return financial_year_start(today), today


def parse_period_date(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def period_from_args(args, today=None):
    default_from, default_to = current_financial_year_period(today)
    date_from = parse_period_date(args.get("date_from")) or default_from
    date_to = parse_period_date(args.get("date_to")) or default_to
    if date_from > date_to:
        date_from, date_to = date_to, date_from
    return date_from, date_to
