from datetime import date
from decimal import Decimal

from app.core.formatting import money
from app.models import Payment


def outstanding_status(paid, balance):
    balance = money(balance)
    paid = money(paid)
    if balance <= Decimal("0.00"):
        return "PAID"
    if paid > Decimal("0.00"):
        return "PARTIAL"
    return "UNPAID"


def document_summary(documents):
    documents = [document for document in documents if document]
    if len(documents) == 1:
        return documents[0]
    return f"{len(documents)} documents"


def party_identity(entry, party_kind):
    if party_kind == "customer":
        party = entry.customer.name if entry.customer else entry.counterparty_company.name if entry.counterparty_company else ""
        party_id = entry.customer_id or entry.counterparty_company_id
    else:
        party = entry.supplier.name if entry.supplier else entry.counterparty_company.name if entry.counterparty_company else ""
        party_id = entry.supplier_id or entry.counterparty_company_id
    return party_id, party


def advance_query_for_party_kind(party_kind):
    query = Payment.query.filter(Payment.unallocated_amount > 0)
    if party_kind == "customer":
        return query.filter(Payment.customer_id.isnot(None))
    return query.filter(Payment.supplier_id.isnot(None))


def party_advance_key(payment, party_kind):
    if party_kind == "customer":
        return payment.company_id, payment.customer_id
    return payment.company_id, payment.supplier_id


def unallocated_advances_by_party(entries, party_kind):
    keys = set()
    for entry in entries:
        party_id, _party = party_identity(entry, party_kind)
        if party_id:
            keys.add((entry.company_id, party_id))
    if not keys:
        return {}
    advances = {}
    for payment in advance_query_for_party_kind(party_kind).all():
        key = party_advance_key(payment, party_kind)
        if key in keys:
            advances[key] = money(advances.get(key, Decimal("0.00")) + payment.unallocated_amount)
    return advances


def net_group_with_advances(group, advance_amount):
    advance_amount = money(advance_amount)
    document_balance = money(group["balance"])
    advance_offset = money(min(document_balance, advance_amount))
    group["advance_offset"] = advance_offset
    group["open_advance"] = money(advance_amount - advance_offset)
    group["paid"] = money(group["paid"] + advance_offset)
    group["balance"] = money(document_balance - advance_offset)
    return group


def party_unallocated_advance(company_id, party_kind, party_id):
    if not party_id:
        return Decimal("0.00")
    query = advance_query_for_party_kind(party_kind).filter(Payment.company_id == company_id)
    if party_kind == "customer":
        query = query.filter(Payment.customer_id == party_id)
    else:
        query = query.filter(Payment.supplier_id == party_id)
    return money(sum((payment.unallocated_amount for payment in query.all()), Decimal("0.00")))


def outstanding_summary_from_rows(rows, company_id, party_kind, party_id):
    total = money(sum((row["total"] for row in rows), Decimal("0.00")))
    document_paid = money(sum((row["paid"] for row in rows), Decimal("0.00")))
    document_balance = money(sum((row["balance"] for row in rows), Decimal("0.00")))
    advance_amount = party_unallocated_advance(company_id, party_kind, party_id)
    advance_offset = money(min(document_balance, advance_amount))
    return {
        "total": total,
        "paid": money(document_paid + advance_offset),
        "document_paid": document_paid,
        "advance_offset": advance_offset,
        "open_advance": money(advance_amount - advance_offset),
        "balance": money(document_balance - advance_offset),
        "document_balance": document_balance,
        "count": len(rows),
    }


def grouped_party_outstanding(entries, party_kind):
    groups = {}
    entries = list(entries)
    advances = unallocated_advances_by_party(entries, party_kind)
    for entry in entries:
        party_id, party = party_identity(entry, party_kind)
        key = (entry.company_id, party_kind, party_id, party)
        group = groups.setdefault(
            key,
            {
                "company_id": entry.company_id,
                "company": entry.company.code,
                "party_id": party_id,
                "party": party,
                "documents": [],
                "date": entry.document_date,
                "due_date": entry.due_date,
                "total": Decimal("0.00"),
                "paid": Decimal("0.00"),
                "balance": Decimal("0.00"),
                "created_by_ids": set(),
            },
        )
        group["documents"].append(entry.document_number)
        group["date"] = min(group["date"], entry.document_date)
        if entry.due_date and (not group["due_date"] or entry.due_date < group["due_date"]):
            group["due_date"] = entry.due_date
        group["total"] = money(group["total"] + entry.total_amount)
        group["paid"] = money(group["paid"] + entry.paid_amount)
        group["balance"] = money(group["balance"] + entry.balance_amount)
        group["created_by_ids"].add(entry.created_by_id)

    rows = []
    for group in groups.values():
        advance_amount = advances.get((group["company_id"], group["party_id"]), Decimal("0.00"))
        net_group_with_advances(group, advance_amount)
        if money(group["balance"]) <= Decimal("0.00"):
            continue
        group["documents_label"] = document_summary(group["documents"])
        group["status"] = outstanding_status(group["paid"], group["balance"])
        rows.append(group)
    return sorted(
        rows,
        key=lambda item: (
            (item["party"] or "").casefold(),
            (item["company"] or "").casefold(),
            item["party_id"] or 0,
            item["due_date"] or date.max,
        ),
    )
