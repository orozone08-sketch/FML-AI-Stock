import {describe,expect,it} from "vitest";
import {planCreateOpeningBalance,planDeleteOpeningBalance,planUpdateOpeningBalance} from "../../src/accounting/opening-balances";
class S{constructor(public q:string,private db:F){} bind(...p:unknown[]){this.db.params=p;return this}first<T>(){return Promise.resolve(this.db.first as T)}all<T>(){return Promise.resolve({results:[]} as T)}}
class F{first:unknown=null;params:unknown[]=[];prepare(q:string){return new S(q,this)}batch<T>(s:S[]){return Promise.resolve(s.map(()=>({results:[{id:7}]})) as T)}}
describe("opening balance plans",()=>{
 it("creates a self-referencing opening receivable",async()=>{const p=await planCreateOpeningBalance(new F() as unknown as D1Database,{kind:"receivable",companyId:1,stockBookId:2,partyId:3,date:"2026-01-01",amount:"12.34"},9);expect(p.id).toBe(7);expect(p.mutations[0]!.sql).toContain("INSERT INTO receivables");expect(p.mutations[0]!.params).toContain(1234)});
 it("protects a paid opening from shrinking",async()=>{const db=new F();db.first={id:4,is_opening:1,source_type:"OPENING_RECEIVABLE",paid_amount_paise:500,company_id:1,customer_id:2};await expect(planUpdateOpeningBalance(db as unknown as D1Database,{id:4,kind:"receivable",companyId:1,stockBookId:1,partyId:2,date:"2026-01-01",amount:"4"},1)).rejects.toThrow(/less than already received/)});
 it("protects allocated advances from deletion",async()=>{const db=new F();db.first={id:4,payment_type:"OPENING_ADVANCE_RECEIVED",allocated_amount_paise:1};await expect(planDeleteOpeningBalance(db as unknown as D1Database,"advance-received",4)).rejects.toThrow(/after allocation/)})
});
