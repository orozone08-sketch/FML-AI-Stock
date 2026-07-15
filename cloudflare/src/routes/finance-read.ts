import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { ReportRepository, printableRows, toCsv } from "../reports";
import { escapeHtml, layout, table } from "../views/html";

const financeRead=new Hono<{Bindings:Env;Variables:AppVariables}>();
function repository(c:any){return new ReportRepository(c.env.DB,{activeCompanyId:c.get("user")!.activeCompanyId});}
function filters(c:any){const company=c.req.query("company_id");return company?{companyId:Number(company)}:{};}
async function listing(c:any){const user=c.get("user")!;if(!can(user,"outstanding","view"))return c.text("Forbidden",403);const [customers,suppliers]=await Promise.all([repository(c).named("customer-outstanding",filters(c)),repository(c).named("supplier-outstanding",filters(c))]);const rows=[...customers.rows.map(r=>({...r,party_type:"CUSTOMER"})),...suppliers.rows.map(r=>({...r,party_type:"SUPPLIER"}))];if(c.req.query("format")){if(!can(user,"outstanding","export"))return c.text("Forbidden",403);return new Response(toCsv(rows),{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":"attachment; filename=outstanding.csv"}});}const p=printableRows(rows);return c.html(layout("Outstanding",table(p.headers.map(escapeHtml),p.rows.map(r=>r.map(escapeHtml))),user));}
financeRead.get("/outstanding",listing);
financeRead.get("/outstanding/customer/:companyId/:customerId",async(c)=>{const user=c.get("user")!;if(!can(user,"outstanding","view"))return c.text("Forbidden",403);try{const profile=await repository(c).customerProfile(Number(c.req.param("customerId")),{companyId:Number(c.req.param("companyId"))});const rows=(profile.sales as Record<string,unknown>[])??[];const p=printableRows(rows);return c.html(layout("Customer Outstanding",table(p.headers.map(escapeHtml),p.rows.map(r=>r.map(escapeHtml))),user));}catch{return c.notFound();}});
financeRead.get("/outstanding/supplier/:companyId/:supplierId",async(c)=>{const user=c.get("user")!;if(!can(user,"outstanding","view"))return c.text("Forbidden",403);try{const profile=await repository(c).supplierProfile(Number(c.req.param("supplierId")),{companyId:Number(c.req.param("companyId"))});const rows=(profile.purchases as Record<string,unknown>[])??[];const p=printableRows(rows);return c.html(layout("Supplier Outstanding",table(p.headers.map(escapeHtml),p.rows.map(r=>r.map(escapeHtml))),user));}catch{return c.notFound();}});

export default financeRead;
