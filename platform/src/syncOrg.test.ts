import { claimNextSync, createOrganization, enqueueDueSyncs, enqueueSync, ensureDemoOrg, failStaleSyncs, type PrismaClient } from "@commitcost/db";
import { generateMockDataset, MockCostProvider, MockVcsProvider } from "@commitcost/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncOrganization, type SyncDeps } from "./syncOrg.js";
import { createTestDb } from "./testDb.js";
import { drainQueue } from "./worker.js";

const data = generateMockDataset({ endDate: "2026-10-05" });
let db: PrismaClient;
let cleanup: () => Promise<void>;

beforeAll(() => {
  ({ db, cleanup } = createTestDb());
}, 60_000);
afterAll(() => cleanup?.());

/** Mock data stands in for the customer's AWS account and repo. */
function mockDeps(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    days: 90,
    today: () => "2026-10-06",
    costProviderFor: async (conn) => ({
      name: "fake-aws",
      getDailyCosts: async (range) =>
        (await new MockCostProvider(data).getDailyCosts(range)).map((r) => ({ ...r, accountId: conn.accountId, source: "aws-cost-explorer" as const })),
    }),
    vcsProviderFor: async (repo) => ({
      name: "fake-github",
      getDeploys: async (range) => (await new MockVcsProvider(data).getDeploys(range)).map((d) => ({ ...d, repo: repo.fullName })),
    }),
    ...overrides,
  };
}

async function connectedOrg(name: string, githubId: number) {
  const user = await db.user.create({ data: { githubId, login: `u${githubId}` } });
  const org = await createOrganization(db, name, user.id);
  await db.awsConnection.create({ data: { orgId: org.id, accountId: "111122223333", roleArn: "arn:aws:iam::111122223333:role/CommitCostReadOnly", tagKey: "app" } });
  const inst = await db.gitHubInstallation.create({ data: { orgId: org.id, installationId: githubId * 10, accountLogin: "acme", accountType: "Organization" } });
  await db.trackedRepo.create({ data: { orgId: org.id, installationId: inst.id, githubRepoId: githubId, fullName: "acme/shop", defaultBranch: "main" } });
  return org;
}

describe("syncOrganization", () => {
  it("syncs a workspace's AWS account and repos, then attributes its spikes", async () => {
    const org = await connectedOrg("Acme", 1);
    const lines: string[] = [];
    const s = await syncOrganization(db, org.id, mockDeps(), (l) => void lines.push(l));
    expect(s.errors).toEqual([]);
    expect(s.costRecords).toBe(data.costs.length);
    expect(s.deploys).toBe(data.deploys.length);
    expect(s.anomalies).toBeGreaterThanOrEqual(data.spikes.length);

    const top = await db.attribution.findFirst({ where: { rank: 1, anomaly: { orgId: org.id, service: "RDS" } }, include: { deploy: true } });
    expect(top?.deploy.commitSha).toBe(data.spikes[0]!.commitSha);
    expect(top?.deploy.repo).toBe("acme/shop");
    expect(lines.join("\n")).toMatch(/AWS 111122223333: stored/);
  }, 60_000);

  it("is incremental and keeps other workspaces' data untouched", async () => {
    const acme = await db.organization.findFirstOrThrow({ where: { name: "Acme" } });
    const before = await db.costRecord.count({ where: { orgId: acme.id } });
    const ranges: string[] = [];
    const deps = mockDeps();
    const inner = deps.costProviderFor;
    deps.costProviderFor = async (c, o) => {
      const p = await inner(c, o);
      return { name: p.name, getDailyCosts: (r) => (ranges.push(`${r.start}..${r.end}`), p.getDailyCosts(r)) };
    };
    await syncOrganization(db, acme.id, deps);
    expect(ranges).toEqual(["2026-10-02..2026-10-05"]);
    expect(await db.costRecord.count({ where: { orgId: acme.id } })).toBe(before);

    const globex = await connectedOrg("Globex", 2);
    await syncOrganization(db, globex.id, mockDeps());
    expect(await db.costRecord.count({ where: { orgId: acme.id } })).toBe(before);
    expect(await db.costAnomaly.count({ where: { orgId: acme.id } })).toBeGreaterThan(0);
    expect(await db.costRecord.count({ where: { orgId: globex.id } })).toBe(before);
  }, 60_000);

  it("records a failing connection and keeps going", async () => {
    const org = await connectedOrg("Initech", 3);
    const s = await syncOrganization(db, org.id, mockDeps({ costProviderFor: async () => Promise.reject(new Error("AccessDenied: role deleted")) }));
    expect(s.errors).toEqual(["AWS 111122223333: AccessDenied: role deleted"]);
    expect(s.deploys).toBe(data.deploys.length);
    const conn = await db.awsConnection.findFirstOrThrow({ where: { orgId: org.id } });
    expect(conn).toMatchObject({ status: "error", lastError: "AccessDenied: role deleted" });
  }, 60_000);

  it("never syncs the demo workspace", async () => {
    const demo = await ensureDemoOrg(db);
    await expect(syncOrganization(db, demo.id, mockDeps())).rejects.toThrow(/demo/);
  });
});

describe("sync queue", () => {
  it("dedupes, claims each job once, and records outcomes", async () => {
    const org = await connectedOrg("Umbrella", 4);
    const a = await enqueueSync(db, org.id, "manual");
    const b = await enqueueSync(db, org.id, "manual");
    expect(b.id).toBe(a.id);

    const [first, second] = await Promise.all([claimNextSync(db, "w1"), claimNextSync(db, "w2")]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    await db.syncRun.update({ where: { id: a.id }, data: { status: "queued", workerId: null } });

    expect(await drainQueue(db, mockDeps(), "w1")).toBe(1);
    const run = await db.syncRun.findUniqueOrThrow({ where: { id: a.id } });
    expect(run.status).toBe("succeeded");
    expect(run.log).toMatch(/Found \d+ cost changes/);
  }, 60_000);

  it("marks a run failed when every source fails", async () => {
    const org = await connectedOrg("Hooli", 5);
    await enqueueSync(db, org.id, "manual");
    const boom = async () => Promise.reject(new Error("nope"));
    await drainQueue(db, mockDeps({ costProviderFor: boom, vcsProviderFor: boom }), "w1");
    const run = await db.syncRun.findFirstOrThrow({ where: { orgId: org.id } });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/nope/);
  }, 60_000);

  it("schedules connected workspaces that are due, and fails abandoned runs", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    await db.syncRun.updateMany({ data: { queuedAt: new Date("2026-10-06T00:00:00Z") } });
    const fresh = await connectedOrg("Fresh", 6);
    await db.syncRun.create({ data: { orgId: fresh.id, trigger: "connect", status: "succeeded", queuedAt: new Date("2026-10-06T11:00:00Z") } });
    const unconnected = await createOrganization(db, "Empty", (await db.user.create({ data: { githubId: 7, login: "u7" } })).id);

    const due = await enqueueDueSyncs(db, 6 * 3_600_000, now);
    expect(due).not.toContain(fresh.id);
    expect(due).not.toContain(unconnected.id);
    expect(due).not.toContain((await ensureDemoOrg(db)).id);
    expect(due.length).toBeGreaterThan(0);

    const stuck = await db.syncRun.create({ data: { orgId: fresh.id, trigger: "manual", status: "running", startedAt: new Date("2026-10-06T10:00:00Z") } });
    expect(await failStaleSyncs(db, 60 * 60_000, now)).toBe(1);
    expect((await db.syncRun.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("failed");
  }, 60_000);
});
