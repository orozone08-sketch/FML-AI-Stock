import { describe, expect, it } from "vitest";
import { AccountingHandler } from "../../src/accounting";
import { planCreateOpeningBalance, planDeleteOpeningBalance, planUpdateOpeningBalance } from "../../src/accounting/opening-balances";
import { planDeletePayment, planReconstructPayment } from "../../src/accounting/payment-reconstruction";
import { verifyCsrf } from "../../src/auth/session";

type Row = Record<string, unknown>;
class Statement {
  params: unknown[] = [];
  constructor(readonly query: string, private db: AuditDb) {}
  bind(...params: unknown[]) { this.params=params; return this; }
  first<T>() { return Promise.resolve(this.db.first(this.query, this.params) as T); }
  all<T>() { return Promise.resolve({results:this.db.all(this.query, this.params)} as T); }
}
class AuditDb {
  batches: Statement[][]=[]; failBatch=false;
  constructor(public rows: Row[]=[]){ }
  prepare(q:string){return new Statement(q,this)}
  first(q:string,p:unknown[]){
    if(q.startsWith("SELECT request_digest")) return this.rows.find(r=>r.lookup==="idempotency")??null;
    if(q.includes("FROM companies")||q.includes("FROM stock_books")||q.includes("FROM customers")||q.includes("FROM suppliers")||q.includes("FROM payment_modes")) return {id:1};
    if(q.includes("FROM items")) return {count:1};
    if(q.includes("FROM payments")) return this.rows.find(r=>r.table==="payments"&&Number(r.id)===Number(p[0]))??null;
    if(q.includes("FROM receivables")) return this.rows.find(r=>r.table==="receivables"&&Number(r.id)===Number(p[0]))??null;
    if(q.includes("FROM payables")) return this.rows.find(r=>r.table==="payables"&&Number(r.id)===Number(p[0]))??null;
    if(q.includes("opening_stocks")) return this.rows.find(r=>r.table==="opening_stocks")??null;
    if(q.includes("COUNT(*) count FROM fifo_layers")) return {count:0};
    return null;
  }
  all(q:string,p:unknown[]){
    if(q.includes("payment_allocations")) return this.rows.filter(r=>r.table==="payment_allocations"&&Number(r.payment_id)===Number(p[0]));
    if(q.includes("FROM receivables")&&!q.includes("WHERE id=?")) return this.rows.filter(r=>r.table==="receivables");
    if(q.includes("FROM payables")&&!q.includes("WHERE id=?")) return this.rows.filter(r=>r.table==="payables");
    return [];
  }
  batch<T>(s:Statement[]){
    if(this.failBatch)return Promise.reject(new Error("D1 batch rolled back"));
    this.batches.push(s);
    if(s.every(x=>x.query.startsWith("SELECT COALESCE(MAX")))return Promise.resolve(s.map((_,i)=>({results:[{id:40+i}]})) as T);
    return Promise.resolve(s.map(()=>({success:true,results:[]})) as T);
  }
}
const rec=(extra:Row={})=>({table:"receivables",id:10,company_id:1,stock_book_id:1,customer_id:2,party_id:2,is_opening:1,source_type:"OPENING_RECEIVABLE",source_id:10,document_number:"OR-1",document_date:"2026-01-01",due_date:null,transaction_type:"GST",total_amount_paise:10000,paid_amount_paise:0,balance_amount_paise:10000,payment_status:"UNPAID",...extra});
const pay=(extra:Row={})=>({table:"payments",id:20,company_id:1,payment_type:"CUSTOMER_RECEIPT",customer_id:2,party_id:2,total_amount_paise:3000,allocated_amount_paise:0,unallocated_amount_paise:3000,...extra});

describe("exhaustive finance and opening parity audit",()=>{
  it("opening receivable/payable and both advance creates preserve scaled totals and opening identity",async()=>{
    for(const kind of ["receivable","payable","advance-received","advance-paid"] as const){const db=new AuditDb(),p=await planCreateOpeningBalance(db as unknown as D1Database,{kind,companyId:1,stockBookId:1,partyId:2,date:"2026-01-01",amount:"123.45"},7);expect(p.mutations[0]!.params).toContain(12345);expect(p.status).toBe("created");if(kind==="receivable"||kind==="payable")expect(p.mutations[0]!.params.filter(x=>x===p.id).length).toBeGreaterThanOrEqual(2);else expect(p.mutations[0]!.params).toContain(kind==="advance-received"?"OPENING_ADVANCE_RECEIVED":"OPENING_ADVANCE_PAID");}
  });
  it("opening edits compute PARTIAL/PAID totals and forbid amount below paid",async()=>{const db=new AuditDb([rec({paid_amount_paise:4000})]);const p=await planUpdateOpeningBalance(db as unknown as D1Database,{id:10,kind:"receivable",companyId:1,stockBookId:1,partyId:2,date:"2026-01-02",amount:"100"},7);expect(p.mutations[0]!.params).toContain(6000);expect(p.mutations[0]!.params).toContain("PARTIAL");await expect(planUpdateOpeningBalance(db as unknown as D1Database,{id:10,kind:"receivable",companyId:1,stockBookId:1,partyId:2,date:"2026-01-02",amount:"30"},7)).rejects.toThrow(/less than already received/)});
  it("paid opening documents and allocated advances cannot be deleted or reassigned",async()=>{const paidDb=new AuditDb([rec({paid_amount_paise:1})]);await expect(planDeleteOpeningBalance(paidDb as unknown as D1Database,"receivable",10)).rejects.toThrow(/after allocation/);await expect(planUpdateOpeningBalance(paidDb as unknown as D1Database,{id:10,kind:"receivable",companyId:2,stockBookId:1,partyId:2,date:"2026-01-01",amount:"100"},1)).rejects.toThrow(/cannot be changed/);const adv=new AuditDb([pay({payment_type:"OPENING_ADVANCE_RECEIVED",allocated_amount_paise:1})]);await expect(planDeleteOpeningBalance(adv as unknown as D1Database,"advance-received",20)).rejects.toThrow(/after allocation/)});
  it("payment edit reverses old allocation, reallocates preferred then oldest, and syncs document and sale totals",async()=>{const db=new AuditDb([pay({allocated_amount_paise:3000,unallocated_amount_paise:0}),rec({id:10,source_type:"SALE",source_id:5,paid_amount_paise:3000,balance_amount_paise:7000}),rec({id:11,source_type:"SALE",source_id:6,document_date:"2025-12-01",paid_amount_paise:0}),{table:"payment_allocations",payment_id:20,target_type:"RECEIVABLE",target_id:10,amount_paise:3000}]);const p=await planReconstructPayment(db as unknown as D1Database,{id:20,companyId:1,paymentType:"CUSTOMER_RECEIPT",partyId:2,date:"2026-01-02",mode:"BANK",amount:"120",preferredTargetId:10},7),sql=p.mutations.map(x=>x.sql).join("\n");expect(sql.indexOf("DELETE FROM payment_allocations")).toBeLessThan(sql.indexOf("INSERT INTO payment_allocations"));expect(sql).toContain("UPDATE receivables");expect(sql).toContain("UPDATE sales");expect(p.mutations.filter(x=>x.sql.startsWith("INSERT INTO payment_allocations"))).toHaveLength(2)});
  it("payment deletion reverses allocation and syncs parent status before deletion",async()=>{const db=new AuditDb([pay({allocated_amount_paise:3000,unallocated_amount_paise:0}),rec({source_type:"SALE",source_id:5,paid_amount_paise:3000,balance_amount_paise:7000}),{table:"payment_allocations",payment_id:20,target_type:"RECEIVABLE",target_id:10,amount_paise:3000}]);const p=await planDeletePayment(db as unknown as D1Database,20),q=p.mutations.map(x=>x.sql);expect(q[0]).toContain("UPDATE receivables");expect(q.join("\n")).toContain("UPDATE sales");expect(q.at(-1)).toContain("DELETE FROM payments")});
  it("opening stock creation commits document, FIFO, ledger, inventory, audit and idempotency atomically",async()=>{const db=new AuditDb();await new AccountingHandler(db as unknown as D1Database).execute({type:"opening.create",userId:1,companyId:1,idempotencyKey:"stock-1",requestDigest:"a",payload:{companyId:1,stockBookId:1,referenceNumber:"OS",date:"2026-01-01",lines:[{itemId:1,quantity:"2",rate:"5"}]}});const q=db.batches.at(-1)!.map(x=>x.query).join("\n");for(const token of ["opening_stocks","fifo_layers","stock_ledger_entries","inventory_balances","audit_logs","idempotency_keys"])expect(q).toContain(token)});
  it("idempotency replays committed finance commands and rejects digest reuse",async()=>{const db=new AuditDb([{lookup:"idempotency",request_digest:"a",status:"COMMITTED",result_type:"OpeningAdvance",result_id:20}]);const h=new AccountingHandler(db as unknown as D1Database),base={type:"opening_advance_received.delete",userId:1,companyId:1,idempotencyKey:"same",requestDigest:"a",payload:{id:20,companyId:1}};await expect(h.execute(base as never)).resolves.toMatchObject({replayed:true,status:"deleted"});await expect(h.execute({...base,requestDigest:"different"} as never)).rejects.toThrow(/different request/)});
  it("CSRF validation accepts authenticated form, JSON, and raw-upload header tokens",async()=>{const context=(contentType:string,value:unknown,headerToken?:string)=>({get:()=>({csrfToken:"secret"}),req:{header:(name:string)=>name.toLowerCase()==="x-csrf-token"?headerToken:contentType,json:()=>Promise.resolve(value),parseBody:()=>Promise.resolve(value)}});await expect(verifyCsrf(context("application/json",{csrf_token:"secret"}) as never)).resolves.toBe(true);await expect(verifyCsrf(context("application/x-www-form-urlencoded",{csrf_token:"secret"}) as never)).resolves.toBe(true);await expect(verifyCsrf(context("application/octet-stream",{},"secret") as never)).resolves.toBe(true);await expect(verifyCsrf(context("application/json",{csrf_token:"wrong"}) as never)).resolves.toBe(false);await expect(verifyCsrf({get:()=>null,req:{}} as never)).resolves.toBe(false)});
  it("a failed D1 batch exposes no successful command result and cannot record a partial commit",async()=>{const db=new AuditDb();db.failBatch=true;await expect(new AccountingHandler(db as unknown as D1Database).execute({type:"opening.create",userId:1,companyId:1,idempotencyKey:"rollback",requestDigest:"r",payload:{companyId:1,stockBookId:1,referenceNumber:"OS",date:"2026-01-01",lines:[{itemId:1,quantity:"1",rate:"1"}]}})).rejects.toThrow(/rolled back/);expect(db.batches).toHaveLength(0)});
});
