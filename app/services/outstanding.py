from datetime import date
from decimal import Decimal

from app.core.formatting import money


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


def grouped_party_outstanding(entries, party_kind):
    groups = {}
    for entry in entries:
        party_id, party = party_identity(entry, party_kind)
        key = (entry.company_id, party_kind, party_id, party)
        group = groups.setdefault(
            key,
            {
                "company": entry.company.code,
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
    for group in sorted(groups.values(), key=lambda item: (item["due_date"] or date.max, item["party"])):
        group["documents_label"] = document_summary(group["documents"])
        group["status"] = outstanding_status(group["paid"], group["balance"])
        rows.append(group)
    return rows
