from io import BytesIO

from flask import send_file
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

from app.core.formatting import money
from app.services.sale_invoice import amount_in_words, profile_for_company


LEFT = 54
RIGHT = 438
MID = 316


def _date_text(value):
    if not value:
        return ""
    return value.strftime("%d-%b-%y").lstrip("0")


def _safe_text(value):
    return " ".join(str(value or "").split())


def _party_name(payment):
    if payment.customer:
        return payment.customer.name
    if payment.supplier:
        return payment.supplier.name
    return ""


def _voucher_type(payment):
    return "Receipt" if payment.payment_type in {"CUSTOMER_RECEIPT", "OPENING_ADVANCE_RECEIVED"} else "Payment"


def _reference(payment):
    return _safe_text(payment.reference_number) or str(payment.id)


def _amount_text(value):
    amount = money(value)
    sign = "-" if amount < 0 else ""
    return f"{sign}Rs. {abs(amount):,.2f}"


def _draw_centered(page, text, y, font="Helvetica", size=9):
    page.setFont(font, size)
    page.drawCentredString((LEFT + RIGHT) / 2, y, _safe_text(text))


def _draw_wrapped(page, text, x, y, max_width, leading=11, max_lines=3, font="Helvetica", size=9):
    page.setFont(font, size)
    words = _safe_text(text).split()
    if not words:
        return y
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and stringWidth(candidate, font, size) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while stringWidth(last + "...", font, size) > max_width and last:
            last = last.rsplit(" ", 1)[0] if " " in last else last[:-1]
        lines[-1] = last + "..."
    for line in lines:
        page.drawString(x, y, line)
        y -= leading
    return y


def _draw_label_value(page, label, value, y, max_width=215):
    label_text = f"{label} :"
    label_font = "Helvetica-Bold"
    label_size = 8
    page.setFont(label_font, label_size)
    page.drawString(LEFT + 4, y, label_text)
    value_x = LEFT + 4 + stringWidth(label_text, label_font, label_size) + 8
    _draw_wrapped(page, value, value_x, y, max_width, leading=11, max_lines=3, size=9)


def export_payment_voucher_pdf(payment):
    company = profile_for_company(payment.company)
    party = _party_name(payment)
    kind = _voucher_type(payment)
    amount = money(payment.total_amount)
    reference = _reference(payment)
    remarks = _safe_text(payment.remarks)
    if remarks.lower().startswith("imported from "):
        remarks = remarks.split(". Original particulars:", 1)[-1].strip()
    account_note = remarks or f"{kind} received" if kind == "Receipt" else remarks or "Supplier payment"

    buffer = BytesIO()
    page = canvas.Canvas(buffer, pagesize=A4)
    page.setTitle(f"{kind} Voucher {reference}")

    y = 806
    _draw_centered(page, company["name"], y, "Helvetica-Bold", 11)
    y -= 14
    for line in company.get("address_lines", []):
        _draw_centered(page, line, y, size=9)
        y -= 13
    extra_lines = []
    if company.get("gstin"):
        extra_lines.append(f"GSTIN/UIN: {company['gstin']}")
    if company.get("state"):
        extra_lines.append(f"State Name : {company['state']}, Code : {company.get('state_code', '')}")
    if company.get("email"):
        extra_lines.append(f"E-Mail : {company['email']}")
    for line in extra_lines:
        _draw_centered(page, line, y, size=9)
        y -= 13

    y -= 18
    _draw_centered(page, f"{kind} Voucher", y, "Helvetica-Bold", 10)

    meta_y = y - 42
    page.setFont("Helvetica", 9)
    page.drawString(LEFT + 4, meta_y, "No.")
    page.drawString(LEFT + 39, meta_y, ":")
    page.setFont("Helvetica-Bold", 9)
    page.drawString(LEFT + 54, meta_y, reference)
    page.setFont("Helvetica", 9)
    page.drawString(MID - 25, meta_y, "Dated")
    page.drawString(MID + 12, meta_y, ":")
    page.setFont("Helvetica-Bold", 9)
    page.drawString(MID + 30, meta_y, _date_text(payment.payment_date))

    table_header_y = meta_y - 25
    page.setStrokeColorRGB(0, 0, 0)
    page.setLineWidth(0.55)
    page.line(LEFT, table_header_y + 10, RIGHT, table_header_y + 10)
    page.setFont("Helvetica", 9)
    page.drawCentredString((LEFT + MID) / 2, table_header_y - 1, "Particulars")
    page.drawCentredString((MID + RIGHT) / 2, table_header_y - 1, "Amount")
    page.line(LEFT, table_header_y - 9, RIGHT, table_header_y - 9)

    table_bottom = 298
    page.line(MID, table_header_y + 10, MID, table_bottom)
    page.setFont("Helvetica-Bold", 8)
    page.drawString(LEFT + 4, table_header_y - 29, "Account :")
    _draw_wrapped(page, party or "General account", LEFT + 49, table_header_y - 29, MID - LEFT - 58, size=9, max_lines=3)
    page.setFont("Helvetica", 9)
    page.drawRightString(RIGHT - 7, table_header_y - 29, f"{amount:,.2f}")

    through_y = table_header_y - 184
    _draw_label_value(page, "Through", payment.mode or "", through_y, max_width=215)
    on_account_y = through_y - 34
    _draw_label_value(page, "On Account of", account_note, on_account_y, max_width=210)

    words_y = table_bottom + 39
    page.setFont("Helvetica-Bold", 8)
    page.drawString(LEFT + 4, words_y, "Amount (in words) :")
    _draw_wrapped(page, amount_in_words(amount), LEFT + 49, words_y - 15, MID - LEFT - 58, leading=11, max_lines=2, size=9)

    page.line(MID, table_bottom + 24, RIGHT, table_bottom + 24)
    page.line(MID, table_bottom, RIGHT, table_bottom)
    page.setFont("Helvetica-Bold", 9)
    page.drawRightString(RIGHT - 7, table_bottom + 8, _amount_text(amount))

    signature_y = 151
    page.setFont("Helvetica", 9)
    page.drawString(LEFT + 4, signature_y, "Receiver's Signature   :")
    page.drawString(MID - 14, signature_y, "Authorised Signatory")

    page.save()
    buffer.seek(0)
    filename = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in f"{kind}_{reference}").strip("-") or f"{kind.lower()}-{payment.id}"
    return send_file(
        buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"{filename}.pdf",
    )