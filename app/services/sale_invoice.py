from collections import defaultdict
from datetime import date
from decimal import Decimal
from io import BytesIO

from flask import send_file
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.core.formatting import fmt_qty, money


COMPANY_INVOICE_PROFILES = {
    "FML": {
        "name": "FIRSTTECH MACHINE LLP",
        "address_lines": [
            "Unit No. B/2 , Girikunj Industrial Estate,",
            "Near Paper Box, Off. Mahakali Caves Road,",
            "Andheri -East, Mumbai - 400093.",
        ],
        "gstin": "27AAIFF5739P1ZO",
        "state": "Maharashtra",
        "state_code": "27",
        "contact": "022-42724058,+91-+91 8591895162",
        "email": "firsttechmachinellp@gmail.com",
        "pan": "AAIFF5739P",
        "bank_holder": "FIRSTTECH MACHINE LLP",
        "bank_name": "Kotak Mahindra Bank",
        "bank_account": "7647407025",
        "bank_branch_ifsc": "Vile Parle (W), Mumbai & KKBK0000674",
    },
    "AI": {
        "name": "ADITYA INTERNATIONAL",
        "address_lines": ["Jewellery factory supplies stock control"],
        "gstin": "",
        "state": "Maharashtra",
        "state_code": "27",
        "contact": "",
        "email": "",
        "pan": "",
        "bank_holder": "ADITYA INTERNATIONAL",
        "bank_name": "",
        "bank_account": "",
        "bank_branch_ifsc": "",
    },
}


ONES = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
]
TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def sale_invoice_context(sale, auto_print=False):
    company_profile = profile_for_company(sale.company)
    buyer = buyer_context(sale.customer)
    lines = [line_context(line, index) for index, line in enumerate(sale.lines, start=1)]
    tax_summary = tax_summary_rows(sale)
    subtotal = money(sale.subtotal)
    gst_total = money(sale.gst_total)
    gst_rate = common_gst_rate(sale)
    cgst_total = money(gst_total / Decimal("2"))
    sgst_total = money(gst_total - cgst_total)
    grand_total = money(sale.grand_total)
    return {
        "sale": sale,
        "document_title": "Tax Invoice",
        "party_label": "Buyer (Bill to)",
        "document_number_label": "Invoice No.",
        "document_number": sale.invoice_number,
        "company_profile": company_profile,
        "buyer": buyer,
        "lines": lines,
        "tax_summary": tax_summary,
        "subtotal": subtotal,
        "cgst_total": cgst_total,
        "sgst_total": sgst_total,
        "grand_total": grand_total,
        "gst_total": gst_total,
        "total_quantity": total_quantity_display(sale),
        "has_gst": gst_total > Decimal("0.00"),
        "cgst_label": tax_ledger_label("CGST", gst_rate),
        "sgst_label": tax_ledger_label("SGST", gst_rate),
        "amount_words": amount_in_words(grand_total),
        "tax_words": amount_in_words(gst_total),
        "invoice_date": tally_date(sale.invoice_date),
        "due_date": tally_date(sale.due_date),
        "payment_terms": payment_terms(sale),
        "dispatch_method": "HAND",
        "terms_of_delivery": sale.remarks or "EX STOCK",
        "invoice_amount": invoice_amount,
        "auto_print": auto_print,
    }


def purchase_invoice_context(purchase, auto_print=False):
    company_profile = profile_for_company(purchase.company)
    buyer = buyer_context(purchase.supplier)
    lines = [purchase_line_context(line, index) for index, line in enumerate(purchase.lines, start=1)]
    tax_summary = tax_summary_rows(purchase)
    subtotal = money(purchase.subtotal)
    gst_total = money(purchase.gst_total)
    gst_rate = common_gst_rate(purchase)
    cgst_total = money(gst_total / Decimal("2"))
    sgst_total = money(gst_total - cgst_total)
    grand_total = money(purchase.grand_total)
    return {
        "purchase": purchase,
        "document_title": "Purchase Invoice",
        "party_label": "Supplier (Bill from)",
        "document_number_label": "Bill No.",
        "document_number": purchase.bill_number,
        "company_profile": company_profile,
        "buyer": buyer,
        "lines": lines,
        "tax_summary": tax_summary,
        "subtotal": subtotal,
        "cgst_total": cgst_total,
        "sgst_total": sgst_total,
        "grand_total": grand_total,
        "gst_total": gst_total,
        "total_quantity": total_quantity_display(purchase),
        "has_gst": gst_total > Decimal("0.00"),
        "cgst_label": tax_ledger_label("CGST", gst_rate, prefix="Input"),
        "sgst_label": tax_ledger_label("SGST", gst_rate, prefix="Input"),
        "amount_words": amount_in_words(grand_total),
        "tax_words": amount_in_words(gst_total),
        "invoice_date": tally_date(purchase.bill_date),
        "due_date": tally_date(purchase.due_date),
        "payment_terms": payment_terms(purchase),
        "dispatch_method": "HAND",
        "terms_of_delivery": purchase.remarks or "EX STOCK",
        "invoice_amount": invoice_amount,
        "auto_print": auto_print,
    }

def profile_for_company(company):
    profile = dict(COMPANY_INVOICE_PROFILES.get((company.code or "").upper(), {}))
    if not profile:
        profile = {
            "name": company.name.upper(),
            "address_lines": [],
            "gstin": "",
            "state": "Maharashtra",
            "state_code": "27",
            "contact": "",
            "email": "",
            "pan": "",
            "bank_holder": company.name.upper(),
            "bank_name": "",
            "bank_account": "",
            "bank_branch_ifsc": "",
        }
    if company.gst_number:
        profile["gstin"] = company.gst_number
    return profile


def buyer_context(customer):
    state = getattr(customer, "state", None) or "Maharashtra"
    state_code = "27" if state.lower() == "maharashtra" else ""
    return {
        "name": customer.name,
        "contact_person": getattr(customer, "contact_person", None) or "",
        "address_lines": text_lines(customer.address),
        "city": getattr(customer, "city", None) or "",
        "state": state,
        "state_code": state_code,
        "mobile": getattr(customer, "mobile", None) or "",
        "whatsapp": getattr(customer, "whatsapp", None) or "",
        "email": getattr(customer, "email", None) or "",
        "gstin": customer.gst_number or "",
    }


def line_context(line, index):
    unit = invoice_unit(line.item.unit)
    return {
        "index": index,
        "description": line.item.name,
        "hsn": line.item.hsn or "",
        "quantity": f"{fmt_qty(line.quantity)} {unit}",
        "rate": invoice_amount(line.sale_rate),
        "unit": unit,
        "amount": invoice_amount(line.subtotal),
    }


def purchase_line_context(line, index):
    unit = invoice_unit(line.item.unit)
    return {
        "index": index,
        "description": line.item.name,
        "hsn": line.item.hsn or "",
        "quantity": f"{fmt_qty(line.quantity)} {unit}",
        "rate": invoice_amount(line.rate),
        "unit": unit,
        "amount": invoice_amount(line.subtotal),
    }

def tax_summary_rows(sale):
    groups = defaultdict(lambda: {"taxable": Decimal("0.00"), "tax": Decimal("0.00")})
    for line in sale.lines:
        key = (line.item.hsn or "", money(line.gst_percent))
        groups[key]["taxable"] += money(line.subtotal)
        groups[key]["tax"] += money(line.gst_amount)

    rows = []
    for (hsn, gst_percent), values in sorted(groups.items(), key=lambda item: item[0]):
        tax = money(values["tax"])
        taxable = money(values["taxable"])
        cgst_rate = money(gst_percent / Decimal("2"))
        cgst_amount = money(tax / Decimal("2"))
        sgst_rate = money(gst_percent - cgst_rate)
        sgst_amount = money(tax - cgst_amount)
        rows.append(
            {
                "hsn": hsn,
                "taxable": invoice_amount(taxable),
                "cgst_rate": percent_text(cgst_rate),
                "cgst_amount": invoice_amount(cgst_amount),
                "sgst_rate": percent_text(sgst_rate),
                "sgst_amount": invoice_amount(sgst_amount),
                "tax": invoice_amount(tax),
            }
        )
    return rows


def common_gst_rate(sale):
    rates = {
        money(line.gst_percent)
        for line in sale.lines
        if money(line.gst_percent) > Decimal("0.00")
    }
    if len(rates) == 1:
        return rates.pop()
    return None


def tax_ledger_label(kind, gst_rate, prefix="Output"):
    if gst_rate:
        half_rate = percent_text(money(gst_rate / Decimal("2")))
        return f"{prefix} {kind} @ {half_rate}%"
    return f"{prefix} {kind}"


def total_quantity_display(sale):
    total = fmt_qty(sum((line.quantity for line in sale.lines), Decimal("0.000")))
    units = {invoice_unit(line.item.unit) for line in sale.lines}
    if len(units) == 1:
        return f"{total} {units.pop()}"
    return total


def payment_terms(sale):
    if sale.payment_status == "PAID":
        return "100% ADVANCE"
    if sale.payment_status == "PARTIAL":
        return "PARTIAL"
    return "CREDIT"


def text_lines(value):
    if not value:
        return []
    return [line.strip() for line in str(value).splitlines() if line.strip()]


def tally_date(value):
    if not value:
        return ""
    if isinstance(value, date):
        return value.strftime("%d-%b-%y")
    return str(value)


def invoice_unit(unit):
    cleaned = (unit or "Nos").strip()
    if cleaned.lower() in {"nos", "no", "pcs", "piece", "pieces"}:
        return "Nos."
    if cleaned.lower() == "kg":
        return "Kgs."
    return f"{cleaned}." if not cleaned.endswith(".") else cleaned


def invoice_amount(value):
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
    return f"{sign}{whole}.{fraction}"


def percent_text(value):
    value = money(value)
    return f"{value:.2f}".rstrip("0").rstrip(".")


def amount_in_words(value):
    amount = money(value)
    rupees = int(abs(amount))
    paise = int((abs(amount) - Decimal(rupees)) * 100)
    words = number_to_words(rupees)
    prefix = "Minus INR" if amount < 0 else "INR"
    if paise:
        return f"{prefix} {words} and {number_to_words(paise)} Paise Only"
    return f"{prefix} {words} Only"


def number_to_words(number):
    number = int(number)
    if number == 0:
        return "Zero"
    parts = []
    for value, label in (
        (10000000, "Crore"),
        (100000, "Lakh"),
        (1000, "Thousand"),
        (100, "Hundred"),
    ):
        count, number = divmod(number, value)
        if count:
            parts.append(f"{two_digit_words(count)} {label}")
    if number:
        if parts:
            parts.append(two_digit_words(number))
        else:
            parts.append(two_digit_words(number))
    return " ".join(parts)


def two_digit_words(number):
    number = int(number)
    if number < 20:
        return ONES[number]
    ten, one = divmod(number, 10)
    return f"{TENS[ten]} {ONES[one]}".strip()


def sale_invoice_filename(sale):
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in sale.invoice_number).strip("-")
    return safe.lower() or f"sale-{sale.id}"


def export_purchase_invoice_pdf(purchase):
    context = purchase_invoice_context(purchase)
    buffer = BytesIO()
    page = canvas.Canvas(buffer, pagesize=A4)
    draw_invoice_pdf(page, context)
    page.save()
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"{purchase_invoice_filename(purchase)}.pdf",
    )

def purchase_invoice_filename(purchase):
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in purchase.bill_number).strip("-")
    return safe.lower() or f"purchase-{purchase.id}"

def export_sale_invoice_pdf(sale):
    context = sale_invoice_context(sale)
    buffer = BytesIO()
    page = canvas.Canvas(buffer, pagesize=A4)
    draw_invoice_pdf(page, context)
    page.save()
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"{sale_invoice_filename(sale)}.pdf",
    )


def draw_invoice_pdf(page, context):
    width, height = A4
    margin = 22
    left = margin
    right = width - margin
    top = height - margin
    bottom = margin
    page.setLineWidth(0.7)
    page.rect(left, bottom, right - left, top - bottom)
    page.setFont("Helvetica", 11)
    page.drawCentredString(width / 2, top - 14, context.get("document_title", "Tax Invoice"))

    y = top - 24
    top_h = 160
    mid_x = left + (right - left) * 0.49
    page.line(left, y, right, y)
    page.line(left, y - top_h, right, y - top_h)
    page.line(mid_x, y, mid_x, y - top_h)

    company = context["company_profile"]
    page.setFont("Helvetica-Bold", 9)
    draw_lines(page, left + 5, y - 13, [company["name"]], 10)
    page.setFont("Helvetica", 8)
    company_lines = company["address_lines"] + [
        f"GSTIN/UIN: {company['gstin']}" if company["gstin"] else "",
        f"State Name : {company['state']}, Code : {company['state_code']}",
        f"Contact : {company['contact']}" if company["contact"] else "",
        f"E-Mail : {company['email']}" if company["email"] else "",
    ]
    draw_lines(page, left + 5, y - 25, [line for line in company_lines if line], 9)

    buyer_y = y - 88
    page.line(left, buyer_y, mid_x, buyer_y)
    buyer = context["buyer"]
    buyer_lines = [
        context.get("party_label", "Buyer (Bill to)"),
        buyer["name"],
        *buyer["address_lines"],
        f"GSTIN/UIN : {buyer['gstin']}" if buyer["gstin"] else "",
        f"State Name : {buyer['state']}, Code : {buyer['state_code']}",
    ]
    page.setFont("Helvetica", 7)
    page.drawString(left + 5, buyer_y - 9, buyer_lines[0])
    page.setFont("Helvetica-Bold", 8)
    page.drawString(left + 5, buyer_y - 20, buyer_lines[1])
    page.setFont("Helvetica", 8)
    draw_lines(page, left + 5, buyer_y - 31, [line for line in buyer_lines[2:] if line], 9)

    draw_meta_pdf(page, mid_x, right, y, top_h, context)

    table_top = y - top_h
    table_bottom = bottom + 213
    draw_items_pdf(page, left, right, table_top, table_bottom, context)

    words_top = table_bottom
    page.line(left, words_top - 44, right, words_top - 44)
    page.setFont("Helvetica", 7)
    page.drawString(left + 5, words_top - 12, "Amount Chargeable (in words)")
    page.setFont("Helvetica-Bold", 8)
    page.drawString(left + 5, words_top - 25, context["amount_words"])
    page.setFont("Helvetica", 7)
    page.drawRightString(right - 5, words_top - 12, "E. & O.E")

    tax_top = words_top - 44
    tax_bottom = bottom + 105
    draw_tax_pdf(page, left, right, tax_top, tax_bottom, context)

    footer_top = tax_bottom
    footer_mid = left + (right - left) * 0.52
    page.line(footer_mid, footer_top, footer_mid, bottom)
    page.setFont("Helvetica", 7)
    page.drawString(left + 5, footer_top - 13, "Tax Amount (in words)")
    page.setFont("Helvetica-Bold", 8)
    page.drawString(left + 5, footer_top - 26, context["tax_words"])
    page.setFont("Helvetica", 7)
    page.drawString(left + 5, footer_top - 48, f"Company's PAN : {company['pan']}")
    page.drawString(left + 5, footer_top - 68, "Declaration")
    page.drawString(left + 5, footer_top - 79, "We declare that this invoice shows the actual price of the")
    page.drawString(left + 5, footer_top - 90, "goods described and that all particulars are true and correct.")
    page.setFont("Helvetica-Bold", 8)
    page.drawString(footer_mid + 5, footer_top - 13, "Company's Bank Details")
    page.setFont("Helvetica", 7)
    bank_lines = [
        f"A/c Holder's Name : {company['bank_holder']}",
        f"Bank Name : {company['bank_name']}",
        f"A/c No. : {company['bank_account']}",
        f"Branch & IFS Code : {company['bank_branch_ifsc']}",
    ]
    draw_lines(page, footer_mid + 5, footer_top - 26, [line for line in bank_lines if not line.endswith(": ")], 10)
    page.setFont("Helvetica-Bold", 8)
    page.drawRightString(right - 5, bottom + 34, f"for {company['name']}")
    page.setFont("Helvetica-Bold", 7)
    page.drawRightString(right - 5, bottom + 9, "Authorised Signatory")
    page.setFont("Helvetica", 7)
    page.drawCentredString(width / 2, bottom - 11, "This is a Computer Generated Invoice")


def draw_meta_pdf(page, mid_x, right, y, top_h, context):
    labels = [
        (context.get("document_number_label", "Invoice No."), context.get("document_number") or context["sale"].invoice_number),
        ("Dated", context["invoice_date"]),
        ("Delivery Note", ""),
        ("Mode/Terms of Payment", context["payment_terms"]),
        ("Reference No. & Date.", ""),
        ("Other References", ""),
        ("Buyer's Order No.", ""),
        ("Dated", ""),
        ("Dispatch Doc No.", ""),
        ("Delivery Note Date", ""),
        ("Dispatched through", context["dispatch_method"]),
        ("Destination", context["buyer"]["city"]),
        ("Terms of Delivery", context["terms_of_delivery"]),
    ]
    col_w = (right - mid_x) / 2
    row_h = top_h / 7
    for index in range(0, 12, 2):
        row = index // 2
        y1 = y - row * row_h
        page.line(mid_x, y1 - row_h, right, y1 - row_h)
        page.line(mid_x + col_w, y1, mid_x + col_w, y1 - row_h)
        for offset in (0, 1):
            label, value = labels[index + offset]
            x = mid_x + offset * col_w + 4
            page.setFont("Helvetica", 6.5)
            page.drawString(x, y1 - 8, label)
            page.setFont("Helvetica-Bold", 7.5)
            page.drawString(x, y1 - 19, str(value or ""))
    terms_y = y - 6 * row_h
    page.setFont("Helvetica", 6.5)
    page.drawString(mid_x + 4, terms_y - 8, labels[-1][0])
    page.setFont("Helvetica-Bold", 7.5)
    page.drawString(mid_x + 4, terms_y - 20, labels[-1][1])


def draw_items_pdf(page, left, right, top, bottom, context):
    cols = [left, left + 28, left + 260, left + 315, left + 384, left + 444, left + 482, right]
    for x in cols:
        page.line(x, top, x, bottom)
    page.line(left, top - 19, right, top - 19)
    headers = ["Sl No.", "Description of Goods", "HSN/SAC", "Quantity", "Rate", "per", "Amount"]
    page.setFont("Helvetica", 7)
    for index, header in enumerate(headers):
        page.drawCentredString((cols[index] + cols[index + 1]) / 2, top - 12, header)
    y = top - 32
    page.setFont("Helvetica", 8)
    for line in context["lines"]:
        page.drawCentredString((cols[0] + cols[1]) / 2, y, str(line["index"]))
        page.setFont("Helvetica-Bold", 8)
        page.drawString(cols[1] + 4, y, line["description"][:42])
        page.setFont("Helvetica", 8)
        page.drawCentredString((cols[2] + cols[3]) / 2, y, line["hsn"])
        page.drawRightString(cols[4] - 4, y, line["quantity"])
        page.drawRightString(cols[5] - 4, y, line["rate"])
        page.drawCentredString((cols[5] + cols[6]) / 2, y, line["unit"])
        page.drawRightString(right - 5, y, line["amount"])
        y -= 16
    if context["has_gst"]:
        page.setFont("Helvetica-Bold", 8)
        page.drawString(cols[1] + 20, y - 8, context["cgst_label"])
        page.drawRightString(right - 5, y - 8, invoice_amount(context["cgst_total"]))
        page.drawString(cols[1] + 20, y - 24, context["sgst_label"])
        page.drawRightString(right - 5, y - 24, invoice_amount(context["sgst_total"]))
    page.line(left, bottom + 20, right, bottom + 20)
    page.setFont("Helvetica-Bold", 8)
    page.drawString(cols[1] + 4, bottom + 7, "Total")
    page.drawRightString(cols[4] - 4, bottom + 7, context["total_quantity"])
    page.drawRightString(right - 5, bottom + 7, invoice_amount(context["grand_total"]))


def draw_tax_pdf(page, left, right, top, bottom, context):
    cols = [left, left + 112, left + 220, left + 285, left + 350, left + 415, left + 480, right]
    page.line(left, top - 18, right, top - 18)
    page.line(left, bottom, right, bottom)
    for x in cols:
        page.line(x, top, x, bottom)
    headers = ["HSN/SAC", "Taxable Value", "Central Tax Rate", "Amount", "State Tax Rate", "Amount", "Total Tax Amount"]
    page.setFont("Helvetica", 6.5)
    for index, header in enumerate(headers):
        page.drawCentredString((cols[index] + cols[index + 1]) / 2, top - 11, header)
    y = top - 32
    for row in context["tax_summary"]:
        page.drawString(cols[0] + 4, y, row["hsn"])
        page.drawRightString(cols[2] - 4, y, row["taxable"])
        page.drawRightString(cols[3] - 4, y, row["cgst_rate"])
        page.drawRightString(cols[4] - 4, y, row["cgst_amount"])
        page.drawRightString(cols[5] - 4, y, row["sgst_rate"])
        page.drawRightString(cols[6] - 4, y, row["sgst_amount"])
        page.drawRightString(right - 4, y, row["tax"])
        y -= 12
    page.setFont("Helvetica-Bold", 7)
    page.drawString(left + 4, bottom + 6, "Total")
    page.drawRightString(cols[2] - 4, bottom + 6, invoice_amount(context["subtotal"]))
    page.drawRightString(cols[4] - 4, bottom + 6, invoice_amount(context["cgst_total"]))
    page.drawRightString(cols[6] - 4, bottom + 6, invoice_amount(context["sgst_total"]))
    page.drawRightString(right - 4, bottom + 6, invoice_amount(context["gst_total"]))


def draw_lines(page, x, y, lines, leading):
    for line in lines:
        page.drawString(x, y, line[:82])
        y -= leading
    return y
