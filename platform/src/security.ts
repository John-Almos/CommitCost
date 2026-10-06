import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** A random, URL-safe bearer token (256 bits). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Session tokens are stored hashed, so a database leak doesn't leak sessions. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Signs a small payload for an OAuth `state` or install link. The payload is
 * readable (base64url JSON), so never put secrets in it; the signature stops
 * tampering, and `exp` stops replay after `ttlMs`.
 */
export function signState<T extends object>(payload: T, secret: string, ttlMs = 10 * 60_000, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + ttlMs })).toString("base64url");
  return `${body}.${hmac(secret, body)}`;
}

/** Returns the payload, or null if the signature is wrong or it has expired. */
export function verifyState<T extends object>(state: string | null | undefined, secret: string, now = Date.now()): T | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig || !safeEqual(sig, hmac(secret, body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof data.exp !== "number" || data.exp < now) return null;
    return data;
  } catch {
    return null;
  }
}

/** Checks GitHub's `X-Hub-Signature-256` header against the raw request body. */
export function verifyWebhookSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(header, expected);
}
