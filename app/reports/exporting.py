import csv
import re
from decimal import Decimal, InvalidOperation
from io import BytesIO, StringIO

from flask import Response, send_file
from openpyxl import Workbook
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def export_table(title, headers, rows, fmt):
    fmt = (fmt or "").lower()
    filename = re.sub(r"[^a-z0-9._-]+", "-", title.lower()).strip("-") or "export"
    if fmt == "csv":
        return export_csv(filename, headers, rows)
    if fmt == "xlsx":
        return export_xlsx(filename, headers, rows)
    if fmt == "pdf":
        return export_pdf(title, filename, headers, rows)
    raise ValueError("Unsupported export format.")


def export_csv(filename, headers, rows):
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(headers)
    writer.writerows(_numeric_row(row) for row in rows)
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}.csv"},
    )


def export_xlsx(filename, headers, rows):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Report"
    sheet.append(headers)
    for row in rows:
        sheet.append(_numeric_row(row))
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            if isinstance(cell.value, Decimal):
                cell.number_format = "#,##0.00;[Red]-#,##0.00"
    for column_cells in sheet.columns:
        length = max(len(str(cell.value or "")) for cell in column_cells)
        sheet.column_dimensions[column_cells[0].column_letter].width = min(
            max(length + 2, 12), 42
        )
    buffer = BytesIO()
    workbook.save(buffer)
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=f"{filename}.xlsx",
    )


def _numeric_value(value):
    """Convert formatted INR strings into spreadsheet-friendly numbers."""
    if not isinstance(value, str) or "₹" not in value:
        return value
    cleaned = value.replace("₹", "").replace(",", "").strip()
    try:
        return Decimal(cleaned)
    except InvalidOperation:
        return value


def _numeric_row(row):
    return [_numeric_value(value) for value in row]


def export_pdf(title, filename, headers, rows):
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        rightMargin=18,
        leftMargin=18,
        topMargin=18,
        bottomMargin=18,
    )
    styles = getSampleStyleSheet()
    data = [headers] + [list(map(str, row)) for row in rows]
    table = Table(data, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#101828")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E5E7EB")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 7),
                (
                    "ROWBACKGROUNDS",
                    (0, 1),
                    (-1, -1),
                    [colors.white, colors.HexColor("#F8FAFC")],
                ),
            ]
        )
    )
    doc.build([Paragraph(title, styles["Title"]), Spacer(1, 12), table])
    buffer.seek(0)
    return send_file(
        buffer,
        mimetype="application/pdf",
        as_attachment=True,
        download_name=f"{filename}.pdf",
    )
