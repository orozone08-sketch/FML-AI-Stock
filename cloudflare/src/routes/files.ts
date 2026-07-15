import { Hono, type Context } from "hono";
import type { AppVariables, Env } from "../types";
import { randomToken } from "../security/crypto";

const files = new Hono<{Bindings:Env;Variables:AppVariables}>();
type Row=Record<string,unknown>;
const MAX_FILE_BYTES=10*1024*1024;
const hex=(bytes:Uint8Array)=>[...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");
const allowed=(user:NonNullable<AppVariables["user"]>,companyId:number)=>user.activeCompanyId===null||user.activeCompanyId===companyId;

const upload=async (c:Context<{Bindings:Env;Variables:AppVariables}>)=>{
 const user=c.get("user")!,companyId=Number(c.req.header("X-Company-Id")??user.activeCompanyId),length=Number(c.req.header("Content-Length")??0);
 if(!Number.isSafeInteger(companyId)||companyId<=0||!allowed(user,companyId))return c.text("Forbidden",403);
 if(user.role==="VIEWER")return c.text("Forbidden",403);
 if(!Number.isSafeInteger(length)||length<=0)return c.text("Content-Length is required.",411);
 if(length>MAX_FILE_BYTES)return c.text("File exceeds the 10 MiB limit.",413);
 const bytes=new Uint8Array(await c.req.arrayBuffer());if(bytes.byteLength!==length)return c.text("Content length mismatch.",400);
 const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))),key=`companies/${companyId}/${randomToken(24)}`,t=new Date().toISOString();
 const requestedType=(c.req.header("Content-Type")??"application/octet-stream").slice(0,255),contentType=/^[\w.+-]+\/[\w.+-]+$/.test(requestedType)?requestedType:"application/octet-stream";
 const inserted=await c.env.DB.prepare("INSERT INTO r2_objects(object_key,company_id,owner_user_id,content_type,size_bytes,sha256,lifecycle_state,created_at) VALUES(?,?,?,?,?,?,'PENDING',?)").bind(key,companyId,user.id,contentType,length,digest,t).run(),id=Number(inserted.meta.last_row_id);
 if(!Number.isSafeInteger(id)||id<=0)throw new Error("Could not allocate file metadata ID.");
 try{await c.env.FILES.put(key,bytes,{httpMetadata:{contentType},customMetadata:{sha256:digest}});await c.env.DB.prepare("UPDATE r2_objects SET lifecycle_state='READY',ready_at=? WHERE id=? AND lifecycle_state='PENDING'").bind(t,id).run();}
 catch(error){await c.env.DB.prepare("UPDATE r2_objects SET lifecycle_state='ORPHANED',deleted_at=? WHERE id=?").bind(new Date().toISOString(),id).run();throw error;}
 return c.json({id,sizeBytes:length,sha256:digest},201);
};
files.post("/",upload);
files.post("/upload",upload);
files.get("/:id",async c=>{const user=c.get("user")!,row=await c.env.DB.prepare("SELECT * FROM r2_objects WHERE id=? AND lifecycle_state='READY'").bind(Number(c.req.param("id"))).first<Row>();if(!row)return c.notFound();if(!allowed(user,Number(row.company_id)))return c.text("Forbidden",403);const object=await c.env.FILES.get(String(row.object_key));if(!object)return c.notFound();return new Response(object.body,{headers:{"Content-Type":String(row.content_type),"Content-Length":String(row.size_bytes),"ETag":object.httpEtag,"Cache-Control":"private, no-store"}})});
files.delete("/:id",async c=>{const user=c.get("user")!,row=await c.env.DB.prepare("SELECT * FROM r2_objects WHERE id=? AND lifecycle_state='READY'").bind(Number(c.req.param("id"))).first<Row>();if(!row)return c.notFound();if(!allowed(user,Number(row.company_id))||(user.role!=="ADMIN"&&Number(row.owner_user_id)!==user.id))return c.text("Forbidden",403);await c.env.FILES.delete(String(row.object_key));await c.env.DB.prepare("UPDATE r2_objects SET lifecycle_state='SOFT_DELETED',deleted_at=? WHERE id=?").bind(new Date().toISOString(),Number(row.id)).run();return c.body(null,204)});
export default files;
