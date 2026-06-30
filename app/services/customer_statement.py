from datetime import date
from decimal import Decimal
from io import BytesIO
import re

from flask import send_file
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.core.formatting import fmt_money, money
from app.models import Company, Payment, Receivable
from app.services.sale_invoice import COMPANY_INVOICE_PROFILES, invoice_amount


def customer_statement_context(profile, selected_company, selected_company_id, date_from, date_to):
    customer = profile["customer"]
    companies = statement_companies(profile, selected_company)
    rows, opening, period_debit, period_credit, closing = statement_rows(
        customer.id,
        selected_company_id,
        date_from,
        date_to,
    )
    return {
        "customer": customer,
        "companies": [company_statement_profile(company) for company in companies],
        "selected_company": selected_company,
        "date_from": date_from,
        "date_to": date_to,
        "period_label": f"{display_date(date_from)} to {display_date(date_to)}",
        "rows": rows,
        "opening": opening,
        "period_debit": period_debit,
        "period_credit": period_credit,
        "closing": closing,
        "opening_display": balance_display(opening),
        "debit_display": fmt_money(period_debit),
        "credit_display": fmt_money(period_credit),
        "closing_display": balance_display(closing),
        "row_count": len([row for row in rows if not row["is_opening"]]),
        "title": f"{customer.name} Ledger Account",
    }


def statement_companies(profile, selected_company):
    if selected_company:
        return [selected_company]
    if profile["companies"]:
        return profile["companies"]
    return Company.query.filter_by(active=True).order_by(Company.code).all()


def company_statement_profile(company):
    profile = dict(COMPANY_INVOICE_PROFILES.get((company.code or "").upper(), {}))
    return {
        "code": company.code,
        "name": profile.get("name") or company.name.upper(),
        "address_lines": profile.get("address_lines") or [],
        "gstin": company.gst_number or profile.get("gstin") or "",
        "state": profile.get("state") or "",
        "state_code": profile.get("state_code") or "",
        "contact": profile.get("contact") or "",
        "email": profile.get("email") or "",
    }


def raw_statement_entries(customer_id, company_id=None):
    receivables = Receivable.query.filter(Receivable.customer_id == customer_id)
    payments = Payment.query.filter(Payment.customer_id == customer_id)
    if company_id:
        receivables = receivables.filter(Receivable.company_id == company_id)
        payments = payments.filter(Payment.company_id == company_id)

    entries = []
    for receivable in receivables.order_by(Receivable.document_date, Receivable.id).all():
        entries.append(
            {
                "date": receivable.document_date,
                "particulars": receivable_particulars(receivable),
                "voucher_type": receivable_voucher_type(receivable),
                "voucher_no": receivable.document_number,
                "debit": money(receivable.total_amount),
                "credit": Decimal("0.00"),
                "remarks": receivable.remarks or "",
                "sort": (receivable.document_date, 1, receivable.id),
            }
        )
    for payment in payments.order_by(Payment.payment_date, Payment.id).all():
        entries.append(
            {
                "date": payment.payment_date,
                "particulars": payment_particulars(payment),
                "voucher_type": payment_voucher_type(payment),
                "voucher_no": payment.reference_number or f"PAY-{payment.id}",
                "debit": Decimal("0.00"),
                "credit": money(payment.total_amount),
                "remarks": payment.remarks or "",
                "sort": (payment.payment_date, 2, payment.id),
            }
        )
    return sorted(entries, key=lambda entry: entry["sort"])


def statement_rows(customer_id, company_id, date_from, date_to):
    entries = raw_statement_entries(customer_id, company_id)
    opening = Decimal("0.00")
    period_entries = []
    for entry in entries:
        movement = money(entry["debit"] - entry["credit"])
        if entry["date"] < date_from:
            opening = money(opening + movement)
        elif entry["date"] <= date_to:
            period_entries.append(entry)

    running = opening
    rows = [display_row(opening_row(date_from, opening), running)]
    period_debit = Decimal("0.00")
    period_credit = Decimal("0.00")
    for entry in period_entries:
        period_debit = money(period_debit + entry["debit"])
        period_credit = money(period_credit + entry["credit"])
        running = money(running + entry["debit"] - entry["credit"])
        rows.append(display_row(entry, running))
    return rows, opening, period_debit, period_credit, running


def opening_row(date_from, opening):
    debit = opening if opening > 0 else Decimal("0.00")
    credit = money(abs(opening)) if opening < 0 else Decimal("0.00")
    return {
        "date": date_from,
        "particulars": "Opening Balance",
        "voucher_type": "",
        "voucher_no": "",
        "debit": money(debit),
        "credit": money(credit),
        "remarks": "",
        "is_opening": True,
    }


def display_row(entry, running_balance):
    row = dict(entry)
    row.setdefault("is_opening", False)
    row["date_display"] = display_date(row["date"])
    row["debit_display"] = fmt_money(row["debit"]) if row["debit"] else ""
    row["credit_display"] = fmt_money(row["credit"]) if row["credit"] else ""
    row["balance_display"] = balance_display(running_balance)
    row["debit_pdf"] = invoice_amount(row["debit"]) if row["debit"] else ""
    row["credit_pdf"] = invoice_amount(row["credit"]) if row["credit"] else ""
    row["balance_pdf"] = balance_pdf(running_balance)
    return row


def receivable_particulars(receivable):
    if receivable.is_opening:
        return "To Opening Balance"
    if receivable.source_type == "SALE":
        sale_type = receivable.transaction_type or ""
        if sale_type.upper() == "GST":
            return "To Sales GST Net"
        if sale_type.upper() == "CASH":
            return "To Sales Cash"
        return f"To Sales {sale_type}".strip()
    return f"To {receivable.source_type.replace('_', ' ').title()}"


def receivable_voucher_type(receivable):
    if receivable.is_opening:
        return "Opening"
    if receivable.source_type == "SALE":
        return "Sales"
    return receivable.source_type.replace("_", " ").title()


def payment_particulars(payment):
    if payment.payment_type == "OPENING_ADVANCE_RECEIVED":
        return "By Opening Advance"
    return f"By {payment.mode or 'Receipt'}"


def payment_voucher_type(payment):
    if payment.payment_type == "OPENING_ADVANCE_RECEIVED":
        return "Opening"
    return "Receipt"


def balance_display(value):
    value = money(value)
    if value == 0:
        return fmt_money(value)
    suffix = "Dr" if value > 0 else "Cr"
    return f"{fmt_money(abs(value))} {suffix}"


def balance_pdf(value):
    value = money(value)
    if value == 0:
        return invoice_amount(value)
    suffix = "Dr" if value > 0 else "Cr"
    return f"{invoice_amount(abs(value))} {suffix}"


def display_date(value):
    if not value:
        return ""
    if isinstance(value, date):
        return f"{value.day}-{value.strftime('%b-%y')}"
    return str(value)


def customer_statement_export_rows(statement):
    rows = []
    for row in statement["rows"]:
        rows.append(
            [
                row["date_display"],
                row["particulars"],
                row["voucher_type"],
                row["voucher_no"],
                row["debit_display"],
                row["credit_display"],
                row["balance_display"],
            ]
        )
    rows.append(["", "Grand Total", "", "", statement["debit_display"], statement["credit_display"], statement["closing_display"]])
    return rows


def customer_statement_export_headers():
    return ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit", "Balance"]


def export_customer_statement_pdf(statement):
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=14 * mm,
        leftMargin=14 * mm,
        topMargin=12 * mm,
        bottomMargin=12 * mm,
        title=statement["title"],
    )
    story = customer_statement_pdf_story(statement)
    doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"{statement_filename(statement)}.pdf",
    )


def customer_statement_pdf_story(statement):
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="CenterTiny", parent=styles["Normal"], alignment=TA_CENTER, fontSize=8, leading=10))
    styles.add(ParagraphStyle(name="CenterSmall", parent=styles["Normal"], alignment=TA_CENTER, fontSize=9, leading=11))
    story = []
    story.extend(company_header_flowables(statement, styles))
    story.extend(customer_header_flowables(statement, styles))
    story.append(Spacer(1, 8))
    story.append(Paragraph(statement["period_label"], styles["CenterTiny"]))
    story.append(Spacer(1, 10))
    story.append(ledger_pdf_table(statement, styles))
    story.append(Spacer(1, 8))
    story.append(summary_pdf_table(statement))
    return story


def company_header_flowables(statement, styles):
    companies = statement["companies"]
    blocks = [company_block(company, styles) for company in companies]
    if not blocks:
        return []
    if len(blocks) == 1:
        return blocks + [Spacer(1, 8)]
    table = Table([blocks], colWidths=[(182 * mm) / len(blocks)] * len(blocks))
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.3, colors.HexColor("#9CA3AF")),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#D1D5DB")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FAFAFA")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return [table, Spacer(1, 8)]


def company_block(company, styles):
    lines = [
        f"<b>{escape(company['name'])}</b>",
        *[escape(line) for line in company["address_lines"]],
    ]
    if company["gstin"]:
        lines.append(f"GSTIN/UIN: {escape(company['gstin'])}")
    if company["state"]:
        state_line = f"State: {escape(company['state'])}"
        if company["state_code"]:
            state_line += f", Code: {escape(company['state_code'])}"
        lines.append(state_line)
    if company["contact"]:
        lines.append(f"Contact: {escape(company['contact'])}")
    if company["email"]:
        lines.append(f"E-Mail: {escape(company['email'])}")
    return Paragraph("<br/>".join(lines), styles["CenterSmall"])


def customer_header_flowables(statement, styles):
    customer = statement["customer"]
    lines = [
        f"<b>{escape(customer.name)}</b>",
        "Ledger Account",
    ]
    address_lines = text_lines(customer.address)
    lines.extend(escape(line) for line in address_lines)
    city_state = ", ".join(value for value in [customer.city, customer.state] if value)
    if city_state:
        lines.append(escape(city_state))
    contact_bits = []
    if customer.mobile:
        contact_bits.append(f"Mobile: {customer.mobile}")
    if customer.whatsapp:
        contact_bits.append(f"WhatsApp: {customer.whatsapp}")
    if contact_bits:
        lines.append(escape(" | ".join(contact_bits)))
    if customer.email:
        lines.append(f"E-Mail: {escape(customer.email)}")
    if customer.gst_number:
        lines.append(f"GSTIN/UIN: {escape(customer.gst_number)}")
    return [Paragraph("<br/>".join(lines), styles["CenterSmall"])]


def ledger_pdf_table(statement, styles):
    data = [
        [
            "Date",
            "Particulars",
            "Vch Type",
            "Vch No.",
            "Debit",
            "Credit",
            "Balance",
        ]
    ]
    for row in statement["rows"]:
        data.append(
            [
                row["date_display"],
                Paragraph(escape(row["particulars"]), styles["Normal"]),
                row["voucher_type"],
                row["voucher_no"],
                row["debit_pdf"],
                row["credit_pdf"],
                row["balance_pdf"],
            ]
        )
    data.append(["", "Grand Total", "", "", invoice_amount(statement["period_debit"]), invoice_amount(statement["period_credit"]), balance_pdf(statement["closing"])])
    table = Table(data, repeatRows=1, colWidths=[19 * mm, 53 * mm, 21 * mm, 28 * mm, 20 * mm, 20 * mm, 21 * mm])
    table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 7.2),
                ("BACKGROUND", (0, 0), (-1, 0), colors.white),
                ("LINEABOVE", (0, 0), (-1, 0), 0.6, colors.black),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.black),
                ("LINEBELOW", (0, -1), (-1, -1), 0.6, colors.black),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("ALIGN", (4, 1), (-1, -1), "RIGHT"),
                ("ALIGN", (0, 0), (0, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#FAFAFA")]),
            ]
        )
    )
    return table


def summary_pdf_table(statement):
    data = [
        ["Opening Balance", "Debit", "Credit", "Closing Balance"],
        [
            balance_pdf(statement["opening"]),
            invoice_amount(statement["period_debit"]),
            invoice_amount(statement["period_credit"]),
            balance_pdf(statement["closing"]),
        ],
    ]
    table = Table(data, colWidths=[45 * mm, 45 * mm, 45 * mm, 45 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.35, colors.HexColor("#9CA3AF")),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#D1D5DB")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F3F4F6")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ALIGN", (0, 1), (-1, -1), "RIGHT"),
                ("FONTSIZE", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return table


def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(196 * mm, 282 * mm, f"Page {doc.page}")
    canvas.restoreState()


def statement_filename(statement):
    raw = f"customer-overall-{statement['customer'].name}"
    return re.sub(r"[^a-z0-9._-]+", "-", raw.lower()).strip("-") or "customer-overall"


def text_lines(value):
    return [line.strip() for line in str(value or "").splitlines() if line.strip()]


def escape(value):
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
