import { describe,expect,it } from "vitest";
import { REPORTS,ReportRepository,toCsv } from "../../src/reports";

function capture(){const calls:{sql:string;params:unknown[]}[]=[];const db={prepare(sql:string){const c={sql,params:[] as unknown[]};calls.push(c);return{bind(...p:unknown[]){c.params=p;return this;},all(){return Promise.resolve({results:[]});}};}};return{db:db as unknown as D1Database,calls};}

describe("confirmed report/export defect regressions",()=>{
 it("uses the real inventory balance value column for current stock",()=>{expect(REPORTS["current-stock"]!.sql).toContain("b.ledger_value_paise fifo_value_paise");expect(REPORTS["current-stock"]!.sql).not.toContain("b.fifo_value_paise");});
 it("qualifies joined report keyset and ordering columns",async()=>{const {db,calls}=capture();await new ReportRepository(db,{activeCompanyId:1}).named("item-ledger",{cursorDate:"2026-07-01",cursorId:9,itemId:4,stockBookId:2});const q=calls[0]!.sql;expect(q).toContain("l.entry_date=? AND l.id<?");expect(q).toContain("ORDER BY l.entry_date DESC, l.id DESC");expect(q).not.toMatch(/ORDER BY[^\n]*,\s*id\s/);});
 it("builds current-stock and joined sales queries without ambiguous bare id ordering",async()=>{for(const name of ["current-stock","sales","customer-ledger"]){const {db,calls}=capture();await new ReportRepository(db,{activeCompanyId:1}).named(name);expect(calls[0]!.sql).not.toMatch(/ORDER BY(?:[^,]+,)?\s*id\s+DESC/);}});
 it("neutralizes CSV formulas including whitespace-prefixed payloads",()=>{const csv=toCsv([{a:"=1+1",b:" +cmd",c:"-2+3",d:"@SUM(A1)",safe:"text"}]);expect(csv).toContain("'=1+1");expect(csv).toContain("' +cmd");expect(csv).toContain("'-2+3");expect(csv).toContain("'@SUM(A1)");expect(csv).not.toMatch(/\r\n"?[\t ]*[=+\-@]/);});
 it("retains exact scaled integer output while sanitizing adjacent text",()=>{const csv=toCsv([{party:"=HYPERLINK(\"https://evil\")",balance_amount_paise:9007199254740991n}]);expect(csv).toContain("90071992547409.91");expect(csv).toContain("'=");});
});
