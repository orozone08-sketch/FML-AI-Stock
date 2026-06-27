from datetime import date

from flask import url_for

from app.core.formatting import fmt_money
from app.models import (
    InterCompanyTransfer,
    OpeningStock,
    Payable,
    Payment,
    Purchase,
    Receivable,
    Sale,
)


def _scope_company(query, column, company_id):
    return query.filter(column == company_id) if company_id else query


def _date_between(query, column, start_date, end_date):
    return query.filter(column >= start_date, column <= end_date)


def _event(events, when, kind, title, company=None, amount=None, url=None, severity="info"):
    if not when:
        return
    events.append(
        {
            "date": when.isoformat(),
            "kind": kind,
            "title": title,
            "company": company.code if company else "",
            "amount": fmt_money(amount) if amount is not None else "",
            "url": url or "",
            "severity": severity,
        }
    )


def _receivable_url(receivable):
    if receivable.source_type == "SALE":
        return url_for("transactions.sale_edit", sale_id=receivable.source_id)
    if receivable.source_type == "OPENING_RECEIVABLE":
        return url_for("transactions.opening_receivable_edit", receivable_id=receivable.id)
    if receivable.customer_id:
        return url_for("masters.customer_detail", customer_id=receivable.customer_id, company_id=receivable.company_id)
    return ""


def _payable_url(payable):
    if payable.source_type == "PURCHASE":
        return url_for("transactions.purchase_edit", purchase_id=payable.source_id)
    if payable.source_type == "OPENING_PAYABLE":
        return url_for("transactions.opening_payable_edit", payable_id=payable.id)
    if payable.supplier_id:
        return url_for("masters.supplier_transaction_detail", supplier_id=payable.supplier_id, company_id=payable.company_id)
    return ""


def build_calendar_events(start_date, end_date, company_id=None):
    today = date.today()
    events = []

    sales = _scope_company(
        _date_between(Sale.query.filter_by(is_void=False), Sale.invoice_date, start_date, end_date),
        Sale.company_id,
        company_id,
    )
    for sale in sales.order_by(Sale.invoice_date, Sale.id).all():
        _event(
            events,
            sale.invoice_date,
            "Sale invoice",
            f"{sale.invoice_number} - {sale.customer.name}",
            sale.company,
            sale.grand_total,
            url_for("transactions.sale_edit", sale_id=sale.id),
        )

    purchases = _scope_company(
        _date_between(Purchase.query.filter_by(is_void=False), Purchase.bill_date, start_date, end_date),
        Purchase.company_id,
        company_id,
    )
    for purchase in purchases.order_by(Purchase.bill_date, Purchase.id).all():
        _event(
            events,
            purchase.bill_date,
            "Purchase bill",
            f"{purchase.bill_number} - {purchase.supplier.name}",
            purchase.company,
            purchase.grand_total,
            url_for("transactions.purchase_edit", purchase_id=purchase.id),
        )

    transfers = _date_between(InterCompanyTransfer.query.filter_by(is_void=False), InterCompanyTransfer.transfer_date, start_date, end_date)
    if company_id:
        transfers = transfers.filter(
            (InterCompanyTransfer.from_company_id == company_id) | (InterCompanyTransfer.to_company_id == company_id)
        )
    for transfer in transfers.order_by(InterCompanyTransfer.transfer_date, InterCompanyTransfer.id).all():
        _event(
            events,
            transfer.transfer_date,
            "Transfer",
            f"{transfer.reference_number} - {transfer.from_company.code} to {transfer.to_company.code}",
            transfer.from_company,
            transfer.total_fifo_value,
            url_for("transactions.transfer_edit", transfer_id=transfer.id),
        )

    payments = _scope_company(
        _date_between(Payment.query, Payment.payment_date, start_date, end_date),
        Payment.company_id,
        company_id,
    )
    for payment in payments.order_by(Payment.payment_date, Payment.id).all():
        party = payment.customer.name if payment.customer else payment.supplier.name if payment.supplier else payment.party_type
        _event(
            events,
            payment.payment_date,
            "Payment",
            f"{payment.payment_type} - {party}",
            payment.company,
            payment.total_amount,
            url_for("payments.payment_edit", payment_id=payment.id) if not payment.payment_type.startswith("OPENING_ADVANCE") else url_for("transactions.opening_advance_edit", payment_id=payment.id),
        )

    receivables = _scope_company(
        _date_between(Receivable.query.filter(Receivable.balance_amount > 0, Receivable.due_date.isnot(None)), Receivable.due_date, start_date, end_date),
        Receivable.company_id,
        company_id,
    )
    for receivable in receivables.order_by(Receivable.due_date, Receivable.id).all():
        party = receivable.customer.name if receivable.customer else receivable.counterparty_company.name if receivable.counterparty_company else ""
        severity = "overdue" if receivable.due_date < today else "today" if receivable.due_date == today else "due"
        _event(
            events,
            receivable.due_date,
            "Receivable due",
            f"{receivable.document_number} - {party}",
            receivable.company,
            receivable.balance_amount,
            _receivable_url(receivable),
            severity,
        )

    payables = _scope_company(
        _date_between(Payable.query.filter(Payable.balance_amount > 0, Payable.due_date.isnot(None)), Payable.due_date, start_date, end_date),
        Payable.company_id,
        company_id,
    )
    for payable in payables.order_by(Payable.due_date, Payable.id).all():
        party = payable.supplier.name if payable.supplier else payable.counterparty_company.name if payable.counterparty_company else ""
        severity = "overdue" if payable.due_date < today else "today" if payable.due_date == today else "due"
        _event(
            events,
            payable.due_date,
            "Payable due",
            f"{payable.document_number} - {party}",
            payable.company,
            payable.balance_amount,
            _payable_url(payable),
            severity,
        )

    opening_stock = _scope_company(
        _date_between(OpeningStock.query.filter_by(is_void=False), OpeningStock.opening_date, start_date, end_date),
        OpeningStock.company_id,
        company_id,
    )
    for opening in opening_stock.order_by(OpeningStock.opening_date, OpeningStock.id).all():
        _event(
            events,
            opening.opening_date,
            "Opening stock",
            opening.reference_number,
            opening.company,
            url=url_for("transactions.opening_stock_edit", opening_id=opening.id),
        )

    events.sort(key=lambda item: (item["date"], item["kind"], item["title"]))
    return events
