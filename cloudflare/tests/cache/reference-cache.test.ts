import { describe, expect, it } from "vitest";
import { cachedReferenceRows, invalidateReferenceRows } from "../../src/cache/reference";
import type { Env } from "../../src/types";

function env():Env { return { SITE_URL:`https://cache-${crypto.randomUUID()}.example` } as Env; }

describe("reference row cache",()=>{
  it("serves a repeated reference lookup without a second D1 loader call",async()=>{
    const current=env();let loads=0;
    const loader=async()=>{loads+=1;return[{id:1,code:"AI"}];};
    expect(await cachedReferenceRows(current,"companies","all",loader)).toEqual([{id:1,code:"AI"}]);
    expect(await cachedReferenceRows(current,"companies","all",loader)).toEqual([{id:1,code:"AI"}]);
    expect(loads).toBe(1);
  });

  it("isolates company-scoped option sets",async()=>{
    const current=env();let loads=0;
    const load=(id:number)=>cachedReferenceRows(current,"stock-books",`company:${id}`,async()=>{loads+=1;return[{id,code:`B${id}`}];});
    expect(await load(1)).toEqual([{id:1,code:"B1"}]);
    expect(await load(2)).toEqual([{id:2,code:"B2"}]);
    expect(loads).toBe(2);
  });

  it("reloads a reference set after explicit mutation invalidation",async()=>{
    const current=env();let version=1;
    const loader=async()=>[{id:version,code:`I${version}`}];
    expect((await cachedReferenceRows(current,"items","all",loader))[0]?.id).toBe(1);
    version=2;
    await invalidateReferenceRows(current,[{kind:"items"}]);
    expect((await cachedReferenceRows(current,"items","all",loader))[0]?.id).toBe(2);
  });
});
