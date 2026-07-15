import { describe, expect, it } from "vitest";
import { createPbkdf2Hash, verifyWerkzeugPbkdf2 } from "../../src/security/crypto";

describe("Cloudflare-compatible password hashes", () => {
  it("uses the maximum PBKDF2 iteration count supported by Workers Web Crypto", async () => {
    const hash = await createPbkdf2Hash("deployment-test-password");
    expect(hash.startsWith("pbkdf2:sha256:100000$")).toBe(true);
    await expect(verifyWerkzeugPbkdf2("deployment-test-password", hash)).resolves.toBe(true);
    await expect(verifyWerkzeugPbkdf2("wrong-password", hash)).resolves.toBe(false);
  });
});
