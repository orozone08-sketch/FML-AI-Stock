type Row = Record<string, number | string | null>;

export const MAX_DOCUMENT_LINES = 100;

export function assertDocumentLineCount(count: number): void {
  if (count < 1) throw new Error("At least one item line is required.");
  if (count > MAX_DOCUMENT_LINES)
    throw new Error(`A document may contain at most ${MAX_DOCUMENT_LINES} item lines.`);
}

async function required(
  db: D1Database,
  query: string,
  params: unknown[],
  message: string,
): Promise<Row> {
  const row = await db
    .prepare(query)
    .bind(...params)
    .first<Row>();
  if (!row) throw new Error(message);
  return row;
}

function unique(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

export async function assertActiveCompany(
  db: D1Database,
  companyId: number,
): Promise<void> {
  await required(
    db,
    "SELECT id FROM companies WHERE id=? AND active=1",
    [companyId],
    "Company was not found or is inactive.",
  );
}

export async function assertActiveBook(
  db: D1Database,
  companyId: number,
  stockBookId: number,
): Promise<void> {
  await required(
    db,
    "SELECT id FROM stock_books WHERE id=? AND company_id=? AND active=1",
    [stockBookId, companyId],
    "Stock book was not found, is inactive, or does not belong to the selected company.",
  );
}

async function assertTransactionBook(
  db: D1Database,
  input: { companyId: number; stockBookId: number; documentType: string },
  action: "purchase" | "sale",
): Promise<void> {
  const documentType = String(input.documentType).toUpperCase();
  if (!['GST', 'CASH'].includes(documentType))
    throw new Error("Transaction type must be GST or CASH.");
  const row = await required(
    db,
    `SELECT sb.book_type,c.allow_gst_purchase,c.allow_cash_purchase,c.allow_gst_sale,c.allow_cash_sale
       FROM companies c JOIN stock_books sb ON sb.company_id=c.id
      WHERE c.id=? AND c.active=1 AND sb.id=? AND sb.active=1`,
    [input.companyId, input.stockBookId],
    "Company or stock book was not found, is inactive, or does not match.",
  );
  if (String(row.book_type).toUpperCase() !== documentType)
    throw new Error(`The selected stock book cannot be used for a ${documentType} ${action}.`);
  const allowed = Number(row[`allow_${documentType.toLowerCase()}_${action}`] ?? 0) === 1;
  if (!allowed)
    throw new Error(`${documentType} ${action}s are not allowed for the selected company.`);
}

export async function assertActiveItems(
  db: D1Database,
  itemIds: readonly number[],
): Promise<void> {
  const ids = unique(itemIds);
  assertDocumentLineCount(itemIds.length);
  const placeholders = ids.map(() => "?").join(",");
  const row = await db
    .prepare(
      `SELECT COUNT(*) count FROM items WHERE active=1 AND id IN(${placeholders})`,
    )
    .bind(...ids)
    .first<Row>();
  if (Number(row?.count ?? 0) !== ids.length)
    throw new Error("One or more items were not found or are inactive.");
}

export async function assertActiveSupplier(
  db: D1Database,
  supplierId: number,
): Promise<void> {
  await required(
    db,
    "SELECT id FROM suppliers WHERE id=? AND active=1",
    [supplierId],
    "Supplier was not found or is inactive.",
  );
}

export async function assertActiveCustomer(
  db: D1Database,
  customerId: number,
): Promise<void> {
  await required(
    db,
    "SELECT id FROM customers WHERE id=? AND active=1",
    [customerId],
    "Customer was not found or is inactive.",
  );
}

export async function assertActivePaymentMode(
  db: D1Database,
  mode: string,
): Promise<void> {
  await required(
    db,
    "SELECT id FROM payment_modes WHERE code=? AND active=1",
    [mode],
    "Payment mode was not found or is inactive.",
  );
}

export async function assertSaleContext(
  db: D1Database,
  input: {
    companyId: number;
    stockBookId: number;
    customerId: number;
    documentType: string;
    itemIds: readonly number[];
  },
): Promise<void> {
  await assertTransactionBook(db, input, "sale");
  await assertActiveCustomer(db, input.customerId);
  await assertActiveItems(db, input.itemIds);
}

export async function assertOpeningStockContext(
  db: D1Database,
  input: { companyId: number; stockBookId: number; itemIds: readonly number[] },
): Promise<void> {
  await assertActiveCompany(db, input.companyId);
  await assertActiveBook(db, input.companyId, input.stockBookId);
  await assertActiveItems(db, input.itemIds);
}

export async function assertPaymentContext(
  db: D1Database,
  input: {
    companyId: number;
    partyId: number;
    customer: boolean;
    mode: string;
  },
): Promise<void> {
  await assertActiveCompany(db, input.companyId);
  if (input.customer) await assertActiveCustomer(db, input.partyId);
  else await assertActiveSupplier(db, input.partyId);
  await assertActivePaymentMode(db, input.mode);
}

export async function assertPurchaseContext(
  db: D1Database,
  input: {
    companyId: number;
    stockBookId: number;
    supplierId: number;
    documentType: string;
    itemIds: readonly number[];
  },
): Promise<void> {
  await assertTransactionBook(db, input, "purchase");
  await assertActiveSupplier(db, input.supplierId);
  await assertActiveItems(db, input.itemIds);
}

export async function assertTransferContext(
  db: D1Database,
  input: {
    companyId: number;
    stockBookId: number;
    toCompanyId: number;
    toStockBookId: number;
    mismatchApproved?: boolean;
    itemIds: readonly number[];
  },
): Promise<void> {
  if (input.companyId === input.toCompanyId)
    throw new Error("Transfer companies must differ.");
  const books=await required(db,`SELECT fb.book_type from_type,tb.book_type to_type
    FROM companies fc JOIN stock_books fb ON fb.company_id=fc.id
    JOIN companies tc ON tc.id=? JOIN stock_books tb ON tb.company_id=tc.id
    WHERE fc.id=? AND fc.active=1 AND tc.active=1 AND fb.id=? AND fb.active=1 AND tb.id=? AND tb.active=1`,
    [input.toCompanyId,input.companyId,input.stockBookId,input.toStockBookId],
    "Transfer company or stock book was not found, is inactive, or does not match.");
  if(String(books.from_type)!==String(books.to_type)&&!input.mismatchApproved)
    throw new Error("This transfer crosses GST and cash stock books and requires approval.");
  await assertActiveItems(db, input.itemIds);
}
