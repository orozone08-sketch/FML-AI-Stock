import {describe,expect,it} from "vitest";
import app from "../../src/app";
import type {Env} from "../../src/types";

const routes=()=>app.routes.map(route=>`${route.method} ${route.path}`);

describe("route and browser parity gap fixes",()=>{
  it("registers company POST and master profile contracts",()=>{
    expect(routes()).toEqual(expect.arrayContaining([
      "POST /login/company/:id",
      "GET /masters/customers/:customerId",
      "GET /masters/customers/:customerId/print",
      "GET /masters/customers/:customerId/export/:fmt",
      "GET /masters/suppliers/:supplierId/transactions",
    ]));
  });

  it("sets HSTS and private no-store globally",async()=>{
    const env={APP_ENV:"test",SITE_URL:"https://example.test",SESSION_HMAC_KEY:"x",CSRF_HMAC_KEY:"x"} as Env;
    const response=await app.request("https://example.test/healthz",{},env);
    expect(response.headers.get("strict-transport-security")).toBe("max-age=63072000; includeSubDomains; preload");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
