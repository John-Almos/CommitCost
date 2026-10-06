import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashToken, newToken, signState, verifyState, verifyWebhookSignature } from "./security.js";

const SECRET = "x".repeat(40);

describe("signed state", () => {
  it("round-trips a payload", () => {
    const s = signState({ orgId: "o1", userId: "u1" }, SECRET);
    expect(verifyState<{ orgId: string }>(s, SECRET)).toMatchObject({ orgId: "o1", userId: "u1" });
  });

  it("rejects tampering, the wrong secret and expiry", () => {
    const s = signState({ orgId: "o1" }, SECRET, 1000, 0);
    const [body, sig] = s.split(".");
    const forged = Buffer.from(JSON.stringify({ orgId: "victim", exp: 1000 })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`, SECRET, 0)).toBeNull();
    expect(verifyState(`${body}.${sig}`, "y".repeat(40), 0)).toBeNull();
    expect(verifyState(s, SECRET, 2000)).toBeNull();
    expect(verifyState(s, SECRET, 500)).not.toBeNull();
    expect(verifyState("garbage", SECRET)).toBeNull();
    expect(verifyState(null, SECRET)).toBeNull();
  });
});

describe("tokens", () => {
  it("are random and stored only as hashes", () => {
    const a = newToken();
    expect(a).not.toBe(newToken());
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });
});

describe("webhook signatures", () => {
  it("accepts GitHub's HMAC and nothing else", () => {
    const body = JSON.stringify({ action: "deleted" });
    const good = `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(body, good, "whsec")).toBe(true);
    expect(verifyWebhookSignature(body + " ", good, "whsec")).toBe(false);
    expect(verifyWebhookSignature(body, good, "other")).toBe(false);
    expect(verifyWebhookSignature(body, null, "whsec")).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=abc", "whsec")).toBe(false);
  });
});
