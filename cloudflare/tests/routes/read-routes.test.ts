import { describe,expect,it } from "vitest";
import reports from "../../src/routes/reports";
import customers from "../../src/routes/customers";
import financeRead from "../../src/routes/finance-read";
import files from "../../src/routes/files";

function contracts(router:{routes:Array<{method:string;path:string}>}) {
  return router.routes.map(route=>`${route.method} ${route.path}`);
}

describe("read route contracts",()=>{
  it("preserves report paths with dedicated routes before the catch-all",()=>{
    expect(contracts(reports)).toEqual(expect.arrayContaining([
      "GET /","GET /item-ledger","GET /customer-ledger","GET /customer-ledger/detail","GET /:name",
    ]));
    expect(contracts(reports).findIndex(v=>v==="GET /customer-ledger/detail")).toBeLessThan(contracts(reports).findIndex(v=>v==="GET /:name"));
  });
  it("preserves all six customer JSON paths",()=>{
    expect(contracts(customers)).toEqual(expect.arrayContaining([
      "GET /","GET /:customerId","GET /:customerId/invoices","GET /:customerId/challans","GET /:customerId/payments","GET /:customerId/stock",
    ]));
  });
  it("preserves outstanding list and party detail paths",()=>{
    expect(contracts(financeRead)).toEqual(expect.arrayContaining([
      "GET /outstanding","GET /outstanding/customer/:companyId/:customerId","GET /outstanding/supplier/:companyId/:supplierId",
    ]));
  });
  it("checks R2 availability without colliding with file-id downloads",()=>{
    expect(contracts(files)).toEqual(expect.arrayContaining(["GET /status","GET /:id"]));
    expect(contracts(files).findIndex(v=>v==="GET /status")).toBeLessThan(contracts(files).findIndex(v=>v==="GET /:id"));
  });
});
