import { randomBytes } from "node:crypto";
import { signState, verifyState } from "@commitcost/platform";
import { cookies } from "next/headers";
import { githubApp, platform } from "./platform";

const NONCE_COOKIE = "cc_oauth";

export type OAuthState =
  | { purpose: "login"; nonce: string; next: string }
  | { purpose: "install"; nonce: string; orgId: string; userId: string; installationId: number };

/** Only same-site paths, so the login flow can't be used as an open redirect. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export const callbackUrl = () => `${platform().appUrl}/auth/github/callback`;

/**
 * Starts a GitHub OAuth round trip. The nonce cookie ties the callback to
 * this browser, so nobody can complete a sign-in into someone else's session.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export async function oauthRedirect(state: DistributiveOmit<OAuthState, "nonce">): Promise<string> {
  const app = githubApp();
  if (!app) throw new Error("GitHub sign-in is not configured");
  const nonce = randomBytes(16).toString("base64url");
  (await cookies()).set(NONCE_COOKIE, nonce, { httpOnly: true, secure: platform().appUrl.startsWith("https://"), sameSite: "lax", path: "/", maxAge: 600 });
  return app.authorizeUrl(callbackUrl(), signState({ ...state, nonce }, platform().secret));
}

/** Verifies the returned state against its signature, expiry and this browser's nonce. Single use. */
export async function consumeOAuthState(raw: string | null): Promise<OAuthState | null> {
  const jar = await cookies();
  const nonce = jar.get(NONCE_COOKIE)?.value;
  jar.delete(NONCE_COOKIE);
  const state = verifyState<OAuthState>(raw, platform().secret);
  return state && nonce && state.nonce === nonce ? state : null;
}
