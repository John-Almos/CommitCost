import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureLocalUser, roleIn, type Organization, type Role, type User } from "@commitcost/db";
import { hashToken, newToken } from "@commitcost/platform";
import { db } from "./db";
import { isLocalMode, platform } from "./platform";

export const SESSION_COOKIE = "cc_session";
export const ORG_COOKIE = "cc_org";
const SESSION_DAYS = 30;

const secureCookies = () => platform().appUrl.startsWith("https://");

/** The signed-in user, or null. In local mode everyone is the local user. */
export const currentUser = cache(async (): Promise<User | null> => {
  if (isLocalMode()) return ensureLocalUser(db);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
});

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** Starts a session. Only callable from route handlers and server actions. */
export async function startSession(userId: string): Promise<void> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", expires: expiresAt });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
  jar.delete(ORG_COOKIE);
}

export async function selectWorkspace(orgId: string): Promise<void> {
  (await cookies()).set(ORG_COOKIE, orgId, { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: 365 * 86_400 });
}

export interface Workspace {
  user: User;
  org: Organization;
  /** "viewer" only for the demo workspace when not a member. */
  role: Role | "viewer";
  /** Every workspace this user can switch to, demo last. */
  all: Organization[];
}

/**
 * The workspace this request acts on: the one in the cookie if the user can
 * see it, else their first workspace, else the demo. Every data query takes
 * `org.id` from here, never from the request, so one company can't read
 * another's data by changing a URL or form field.
 */
export const currentWorkspace = cache(async (): Promise<Workspace | null> => {
  const user = await currentUser();
  if (!user) return null;
  const memberships = await db.membership.findMany({ where: { userId: user.id }, include: { org: true }, orderBy: { createdAt: "asc" } });
  const demo = await db.organization.findFirst({ where: { isDemo: true } });
  const all = [...memberships.map((m) => m.org).filter((o) => !o.isDemo), ...(demo ? [demo] : [])];
  if (all.length === 0) return null;

  const wanted = (await cookies()).get(ORG_COOKIE)?.value;
  const org = all.find((o) => o.id === wanted) ?? all[0]!;
  const role = await roleIn(db, user.id, org);
  if (!role) return null;
  return { user, org, role, all };
});

/** For pages: sends signed-out users to /login and users with no workspace to /onboarding. */
export async function requireWorkspace(): Promise<Workspace> {
  await requireUser();
  const ws = await currentWorkspace();
  if (!ws) redirect("/onboarding");
  return ws;
}

/** For mutations: the caller must be an owner of the current, non-demo workspace. */
export async function requireOwner(): Promise<Workspace & { role: "owner" }> {
  const ws = await requireWorkspace();
  if (ws.org.isDemo || ws.role !== "owner") throw new Error("Only workspace owners can change connections.");
  return ws as Workspace & { role: "owner" };
}

/** For mutations any member may do (e.g. Sync now). */
export async function requireMember(): Promise<Workspace> {
  const ws = await requireWorkspace();
  if (ws.org.isDemo || ws.role === "viewer") throw new Error("You're not a member of this workspace.");
  return ws;
}

