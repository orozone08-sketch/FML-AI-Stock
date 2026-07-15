import { Hono } from "hono";
import type { AppVariables, Env } from "../types";
import { can } from "../security/permissions";
import { ReportRepository } from "../reports";

const customers = new Hono<{ Bindings: Env; Variables: AppVariables }>();
type Row=Record<string,unknown>;
function repo(c:any){ const user=c.get("user")!; return new ReportRepository(c.env.DB,{activeCompanyId:user.activeCompanyId}); }
function allowed(c:any){ return can(c.get("user"),"customers","view"); }
function id(c:any){ const value=Number(c.req.param("customerId")); return Number.isSafeInteger(value)&&value>0?value:null; }
function company(c:any){ const raw=c.req.query("company_id"); return raw?Number(raw):undefined; }
function companyFilter(c:any){ const value=company(c); return value===undefined?{}:{companyId:value}; }

customers.get("",async(c)=>{ if(!allowed(c)) return c.text("Forbidden",403); const user=c.get("user")!; const q=(c.req.query("q")??"").trim().toLowerCase().slice(0,100); const where=["active=1"],values:unknown[]=[]; if(q){where.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(COALESCE(city,'')) LIKE ?)"); values.push(`${q}%`,`${q}%`,`%${q}%`);} const rows=await c.env.DB.prepare(`SELECT id,code,name,contact_person,customer_type,gst_number,mobile,whatsapp,email,city,state,default_credit_days,active FROM customers WHERE ${where.join(" AND ")} ORDER BY code,id LIMIT 101`).bind(...values).all<Row>(); return c.json({customers:rows.results.slice(0,100),has_more:rows.results.length>100,company_id:user.activeCompanyId}); });
customers.get("/:customerId",async(c)=>{ if(!allowed(c)) return c.text("Forbidden",403); const customerId=id(c); if(!customerId)return c.text("Invalid customer",400); try{return c.json(await repo(c).customerProfile(customerId,companyFilter(c)));}catch{return c.notFound();} });
customers.get("/:customerId/invoices",async(c)=>{ if(!allowed(c))return c.text("Forbidden",403); const customerId=id(c);if(!customerId)return c.text("Invalid customer",400); try{return c.json((await repo(c).customerProfile(customerId,companyFilter(c))).sales);}catch{return c.notFound();} });
customers.get("/:customerId/payments",async(c)=>{ if(!allowed(c))return c.text("Forbidden",403); const customerId=id(c);if(!customerId)return c.text("Invalid customer",400); try{return c.json((await repo(c).customerProfile(customerId,companyFilter(c))).payments);}catch{return c.notFound();} });
customers.get("/:customerId/challans",async(c)=>{ if(!allowed(c))return c.text("Forbidden",403); const customerId=id(c);if(!customerId)return c.text("Invalid customer",400); const user=c.get("user")!; const scope=user.activeCompanyId?" AND t.to_company_id=?":""; const args=user.activeCompanyId?[customerId,user.activeCompanyId]:[customerId]; const rows=await c.env.DB.prepare(`SELECT t.id,t.transfer_date date,t.reference_number,t.from_company_id,t.to_company_id,t.total_fifo_value_paise FROM inter_company_transfers t JOIN sales s ON s.company_id=t.to_company_id WHERE s.customer_id=?${scope} AND t.is_void=0 GROUP BY t.id ORDER BY t.transfer_date DESC,t.id DESC LIMIT 100`).bind(...args).all<Row>(); return c.json(rows.results); });
customers.get("/:customerId/stock",async(c)=>{ if(!allowed(c))return c.text("Forbidden",403); const customerId=id(c);if(!customerId)return c.text("Invalid customer",400); const user=c.get("user")!; const scope=user.activeCompanyId?" AND s.company_id=?":""; const args=user.activeCompanyId?[customerId,user.activeCompanyId]:[customerId]; const rows=await c.env.DB.prepare(`SELECT i.id item_id,i.code item_code,i.name item,i.unit,SUM(sl.quantity_milliunits) quantity_milliunits,SUM(sl.fifo_cost_paise) fifo_value_paise FROM sale_lines sl JOIN sales s ON s.id=sl.sale_id JOIN items i ON i.id=sl.item_id WHERE s.customer_id=?${scope} AND s.is_void=0 GROUP BY i.id ORDER BY i.code LIMIT 200`).bind(...args).all<Row>(); return c.json(rows.results); });

export default customers;
