import type { Money, Quantity } from "./scalars";

export function assertPaymentInvariant(total: Money, allocated: Money, unallocated: Money) {
  if (total < 0n || allocated < 0n || unallocated < 0n || allocated + unallocated !== total) throw new Error("Payment allocation invariant failed.");
}
export function assertDocumentPaymentInvariant(total: Money, paid: Money, balance: Money) {
  if (paid < 0n || balance < 0n || paid + balance !== total) throw new Error("Document payment invariant failed.");
}
export function assertInventoryInvariant(balance: Quantity, movements: readonly { quantityIn: Quantity; quantityOut: Quantity }[]) {
  const ledger = movements.reduce((sum, row) => sum + row.quantityIn - row.quantityOut, 0n);
  if (ledger !== balance) throw new Error("Inventory balance does not equal stock ledger movements.");
}
export function assertFifoInvariant(original: Quantity, available: Quantity, consumed: Quantity) {
  if (original < 0n || available < 0n || consumed < 0n || available + consumed !== original) throw new Error("FIFO quantity invariant failed.");
}
