import type { CommandEnvelope } from "../types";

export type LineInput = { itemId: number; quantity: string | number; rate: string | number; gstPercent?: string | number; remarks?: string };
export type OpeningCommand = { id?: number; companyId: number; stockBookId: number; referenceNumber: string; date: string; remarks?: string; lines: LineInput[] };
export type PurchaseCommand = OpeningCommand & { supplierId: number; documentType: "GST" | "CASH"; dueDate?: string };
export type SaleCommand = OpeningCommand & { customerId: number; documentType: "GST" | "CASH"; dueDate?: string };
export type PaymentCommand = { id?: number; companyId: number; paymentType: "CUSTOMER_RECEIPT" | "SUPPLIER_PAYMENT" | "OPENING_ADVANCE_RECEIVED" | "OPENING_ADVANCE_PAID"; partyId: number; date: string; mode: string; referenceNumber?: string; amount: string | number; preferredTargetId?: number; remarks?: string };
export type TransferCommand = OpeningCommand & { toCompanyId: number; toStockBookId: number; mismatchApproved?: boolean; approvalReason?: string; reason?: string };
export type OpeningPendingCommand = {
  companyId: number;
  toCompanyId: number;
  stockBookId?: number;
  toStockBookId?: number;
  referenceNumber: string;
  date: string;
  remarks?: string;
  lines: Array<{ itemId: number; quantity: string | number }>;
};
export type VoidCommand = { id: number; reason?: string };
export type AccountingEnvelope = CommandEnvelope<OpeningCommand | PurchaseCommand | SaleCommand | PaymentCommand | TransferCommand | OpeningPendingCommand | VoidCommand>;

export type CommandResult = { type: string; id: number; status: "created" | "updated" | "voided" | "deleted"; replayed?: boolean };
