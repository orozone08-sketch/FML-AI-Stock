import { type Money, type Quantity, type Rate, multiplyQuantityRate } from "./scalars";

export type TransferDirection = "ISSUE" | "RETURN" | "OPENING" | "VOID";
export type TransferFact = { id: number; date: string; fromCompanyId: number; toCompanyId: number; direction: TransferDirection; quantity: Quantity; rate: Rate };
export type PendingLot = { transferId: number; quantity: Quantity; rate: Rate };

export function inferTransferDirection(fact: { isVoid: boolean; opening: boolean; hasConsumption: boolean; hasDestinationIn: boolean }): TransferDirection {
  if (fact.isVoid) return "VOID";
  if (fact.opening) return "OPENING";
  if (fact.hasConsumption) return "ISSUE";
  if (fact.hasDestinationIn) return "RETURN";
  return "ISSUE";
}

function subtract(lots: PendingLot[], quantity: Quantity) {
  let remaining = quantity;
  for (const lot of lots) {
    if (remaining <= 0n) break;
    const take = lot.quantity < remaining ? lot.quantity : remaining;
    lot.quantity = (lot.quantity - take) as Quantity;
    remaining = (remaining - take) as Quantity;
  }
  return remaining;
}

export function pendingTransferLots(ownerCompanyId: number, userCompanyId: number, facts: readonly TransferFact[]) {
  const lots: PendingLot[] = [];
  for (const fact of [...facts].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)) {
    if (fact.direction === "VOID") continue;
    if (fact.fromCompanyId === ownerCompanyId && fact.toCompanyId === userCompanyId && (fact.direction === "ISSUE" || fact.direction === "OPENING"))
      lots.push({ transferId: fact.id, quantity: fact.quantity, rate: fact.rate });
    else if (fact.fromCompanyId === userCompanyId && fact.toCompanyId === ownerCompanyId && fact.direction === "RETURN") subtract(lots, fact.quantity);
  }
  return lots.filter((lot) => lot.quantity > 0n);
}

export function consumePendingLots(input: readonly PendingLot[], required: Quantity) {
  const available = input.reduce((sum, lot) => sum + lot.quantity, 0n) as Quantity;
  if (available < required) throw new RangeError(`Cannot return more stock than pending. Pending: ${available}; requested: ${required}.`);
  let remaining = required;
  const pieces: Array<PendingLot & { value: Money }> = [];
  for (const lot of input) {
    if (remaining <= 0n) break;
    const take = lot.quantity < remaining ? lot.quantity : remaining;
    pieces.push({ transferId: lot.transferId, quantity: take, rate: lot.rate, value: multiplyQuantityRate(take, lot.rate) });
    remaining = (remaining - take) as Quantity;
  }
  return { pieces, totalValue: pieces.reduce((sum, piece) => sum + piece.value, 0n) as Money };
}
