import { type Money, paymentStatus } from "./scalars";

export type Outstanding = { id: number; companyId: number; partyId: number; dueDate: string | null; documentDate: string; total: Money; paid: Money };
export type Allocation = { targetId: number; amount: Money };

const ordered = (rows: readonly Outstanding[]) => [...rows].sort((a, b) => (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") || a.documentDate.localeCompare(b.documentDate) || a.id - b.id);

export function allocatePayment(total: Money, companyId: number, partyId: number, rows: readonly Outstanding[], preferredId?: number) {
  if (total <= 0n) throw new RangeError("Payment amount must be greater than zero.");
  let remaining = total;
  const updated = rows.map((row) => ({ ...row }));
  const byId = new Map(updated.map((row) => [row.id, row]));
  const candidates = preferredId === undefined ? ordered(updated) : [byId.get(preferredId), ...ordered(updated).filter((row) => row.id !== preferredId)];
  const allocations: Allocation[] = [];
  for (const row of candidates) {
    if (!row || remaining <= 0n) continue;
    if (row.companyId !== companyId) { if (row.id === preferredId) throw new Error("The selected document belongs to a different company."); continue; }
    if (row.partyId !== partyId) { if (row.id === preferredId) throw new Error("The selected document belongs to a different party."); continue; }
    const balance = row.total - row.paid;
    const amount = balance < remaining ? balance : remaining;
    if (amount <= 0n) continue;
    row.paid = (row.paid + amount) as Money;
    allocations.push({ targetId: row.id, amount: amount as Money });
    remaining = (remaining - amount) as Money;
  }
  return { outstandings: updated, allocations, allocated: (total - remaining) as Money, unallocated: remaining as Money };
}

export function reverseAllocations(rows: readonly Outstanding[], allocations: readonly Allocation[]) {
  const updated = rows.map((row) => ({ ...row }));
  const byId = new Map(updated.map((row) => [row.id, row]));
  for (const allocation of allocations) {
    const row = byId.get(allocation.targetId);
    if (row) row.paid = (row.paid > allocation.amount ? row.paid - allocation.amount : 0n) as Money;
  }
  return updated;
}

export const outstandingState = (row: Outstanding) => ({ balance: (row.total - row.paid) as Money, status: paymentStatus(row.total, row.paid) });
