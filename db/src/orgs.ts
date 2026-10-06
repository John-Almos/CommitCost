import { randomBytes } from "node:crypto";
import type { Organization, PrismaClient, SyncRun } from "@prisma/client";

export const DEMO_ORG_SLUG = "demo";

/** URL-safe slug from a company name; a short random suffix keeps it unique. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

/** Random external ID for the customer's IAM trust policy. AWS allows 2-1224 chars of [\w+=,.@:/-]. */
export function newExternalId(): string {
  return `cc-${randomBytes(18).toString("base64url")}`;
}

/** Creates a workspace with `ownerId` as its owner. */
export async function createOrganization(db: PrismaClient, name: string, ownerId: string): Promise<Organization> {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) throw new Error("Workspace name is required");
  const base = slugify(trimmed);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 && base !== DEMO_ORG_SLUG ? base : `${base}-${randomBytes(3).toString("hex")}`;
    if (await db.organization.findUnique({ where: { slug }, select: { id: true } })) continue;
    return db.organization.create({
      data: { slug, name: trimmed, awsExternalId: newExternalId(), memberships: { create: { userId: ownerId, role: "owner" } } },
    });
  }
  throw new Error("Could not allocate a workspace URL; try a different name");
}

/** The shared mock-data workspace. Created on first use. */
export async function ensureDemoOrg(db: PrismaClient): Promise<Organization> {
  return db.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    create: { slug: DEMO_ORG_SLUG, name: "Demo (mock data)", isDemo: true, awsExternalId: newExternalId() },
    update: {},
  });
}

export type Role = "owner" | "member";

/**
 * The user's role in an organization, or null if they can't see it. Everyone
 * can read the demo workspace; nobody can change it.
 */
export async function roleIn(db: PrismaClient, userId: string, org: Pick<Organization, "id" | "isDemo">): Promise<Role | "viewer" | null> {
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId: org.id } }, select: { role: true } });
  if (m) return m.role as Role;
  return org.isDemo ? "viewer" : null;
}

/** Turns pending invites for this GitHub login into memberships. */
export async function claimInvites(db: PrismaClient, userId: string, githubLogin: string): Promise<number> {
  const invites = await db.invite.findMany({ where: { githubLogin: githubLogin.toLowerCase() } });
  for (const inv of invites) {
    await db.$transaction([
      db.membership.upsert({
        where: { userId_orgId: { userId, orgId: inv.orgId } },
        create: { userId, orgId: inv.orgId, role: inv.role },
        update: {},
      }),
      db.invite.delete({ where: { id: inv.id } }),
    ]);
  }
  return invites.length;
}

// ---------------------------------------------------------------------------
// Sync queue. SyncRun rows are the queue: the web app inserts "queued" rows,
// workers claim them with a conditional update so two workers never run the
// same job, and the scheduler enqueues organizations that are due.
// ---------------------------------------------------------------------------

export type SyncTrigger = "schedule" | "manual" | "connect";

/** Queues a sync unless one is already queued or running for the org. */
export async function enqueueSync(db: PrismaClient, orgId: string, trigger: SyncTrigger): Promise<SyncRun> {
  const pending = await db.syncRun.findFirst({ where: { orgId, status: { in: ["queued", "running"] } }, orderBy: { queuedAt: "desc" } });
  if (pending) return pending;
  return db.syncRun.create({ data: { orgId, trigger } });
}

/** Claims the oldest queued run. Returns null when there is nothing to do or another worker won. */
export async function claimNextSync(db: PrismaClient, workerId: string): Promise<SyncRun | null> {
  const next = await db.syncRun.findFirst({ where: { status: "queued" }, orderBy: { queuedAt: "asc" } });
  if (!next) return null;
  const claimed = await db.syncRun.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "running", startedAt: new Date(), workerId },
  });
  return claimed.count === 1 ? db.syncRun.findUnique({ where: { id: next.id } }) : null;
}

export async function appendSyncLog(db: PrismaClient, runId: string, line: string): Promise<void> {
  const run = await db.syncRun.findUnique({ where: { id: runId }, select: { log: true } });
  const log = run?.log ? `${run.log}\n${line}` : line;
  // Bounded so a chatty run can't grow the row without limit.
  await db.syncRun.update({ where: { id: runId }, data: { log: log.slice(-20_000) } });
}

export async function finishSync(db: PrismaClient, runId: string, error?: string): Promise<void> {
  await db.syncRun.update({
    where: { id: runId },
    data: { status: error ? "failed" : "succeeded", finishedAt: new Date(), error: error ? error.slice(0, 2000) : null },
  });
}

/**
 * Runs left "running" by a worker that died are failed after `staleMs`, so
 * the org isn't stuck (enqueueSync refuses while one is running).
 */
export async function failStaleSyncs(db: PrismaClient, staleMs: number, now = new Date()): Promise<number> {
  const res = await db.syncRun.updateMany({
    where: { status: "running", startedAt: { lt: new Date(now.getTime() - staleMs) } },
    data: { status: "failed", finishedAt: now, error: "Worker stopped before finishing; will retry on the next schedule." },
  });
  return res.count;
}

/**
 * Queues a scheduled sync for every connected, non-demo org whose last run
 * started more than `intervalMs` ago. Returns the org ids queued.
 */
export async function enqueueDueSyncs(db: PrismaClient, intervalMs: number, now = new Date()): Promise<string[]> {
  const orgs = await db.organization.findMany({
    where: { isDemo: false, awsAccounts: { some: {} }, repos: { some: {} } },
    select: { id: true, syncRuns: { orderBy: { queuedAt: "desc" }, take: 1, select: { queuedAt: true } } },
  });
  const due = orgs.filter((o) => !o.syncRuns[0] || now.getTime() - o.syncRuns[0].queuedAt.getTime() >= intervalMs);
  for (const o of due) await enqueueSync(db, o.id, "schedule");
  return due.map((o) => o.id);
}

/** The single user of local mode (no sign-in configured). GitHub never issues id 0. */
export const LOCAL_USER_GITHUB_ID = 0;

export async function ensureLocalUser(db: PrismaClient) {
  return db.user.upsert({
    where: { githubId: LOCAL_USER_GITHUB_ID },
    create: { githubId: LOCAL_USER_GITHUB_ID, login: "local", name: "Local user" },
    update: {},
  });
}

/** Workspace used by the CLI's env-based `sync` (self-hosted, local AWS credentials). */
export async function ensureCliOrg(db: PrismaClient, slug: string): Promise<Organization> {
  const existing = await db.organization.findUnique({ where: { slug } });
  if (existing) return existing;
  const user = await ensureLocalUser(db);
  return db.organization.create({
    data: { slug, name: slug === "local" ? "Local" : slug, awsExternalId: newExternalId(), memberships: { create: { userId: user.id, role: "owner" } } },
  });
}
