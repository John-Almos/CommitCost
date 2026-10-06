import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMockDataset } from "@commitcost/providers";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "@commitcost/engine";
import { ensureDemoOrg, createOrganization } from "./orgs.js";
import { clearOrgData, latestCostDate, latestDeployDate, loadCostRecords, loadDailyServiceTotals, loadDeploys, saveAnalysis, saveCostRecords, saveDeploys } from "./repository.js";

const dbDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "commitcost-db-"));
const url = `file:${join(tmp, "test.db")}`;
const data = generateMockDataset({ endDate: "2026-10-05" });
let db: PrismaClient;
let orgId: string;

beforeAll(async () => {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"], {
    cwd: dbDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url } } });
  orgId = (await ensureDemoOrg(db)).id;
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

describe("repository", () => {
  it("round-trips mock costs and deploys", async () => {
    await saveCostRecords(db, orgId, data.costs);
    await saveDeploys(db, orgId, data.deploys);

    expect(await db.costRecord.count()).toBe(data.costs.length);
    expect(await db.deploy.count()).toBe(data.deploys.length);

    const spike = data.spikes[0]!;
    const stored = await db.deploy.findUnique({
      where: { orgId_repo_commitSha: { orgId, repo: data.repo, commitSha: spike.commitSha } },
      include: { files: true },
    });
    expect(stored?.title).toBe(spike.title);
    expect(stored?.files.map((f) => f.path)).toContain("services/api/src/routes/orders.ts");
  }, 60_000);

  it("sums tag rows into daily service totals", async () => {
    const totals = await loadDailyServiceTotals(db, orgId);
    expect(totals).toHaveLength(90 * 6);
    const expected = data.costs
      .filter((r) => r.date === "2026-09-01" && r.service === "EC2")
      .reduce((sum, r) => sum + r.amountUsd, 0);
    const got = totals.find((t) => t.date === "2026-09-01" && t.service === "EC2")!.amountUsd;
    expect(got).toBeCloseTo(expected, 2);
  });

  it("is idempotent on re-save", async () => {
    await saveCostRecords(db, orgId, data.costs.slice(0, 50));
    await saveDeploys(db, orgId, data.deploys.slice(0, 5));
    expect(await db.costRecord.count()).toBe(data.costs.length);
    expect(await db.deploy.count()).toBe(data.deploys.length);
    const files = await db.deployFile.count();
    expect(files).toBe(data.deploys.reduce((n, d) => n + d.files.length, 0));
  }, 60_000);

  it("loads stored data back as domain objects", async () => {
    expect(await loadCostRecords(db, orgId)).toHaveLength(data.costs.length);
    const deploys = await loadDeploys(db, orgId, data.repo);
    expect(deploys.find((d) => d.commitSha === data.spikes[0]!.commitSha)).toEqual(data.deploys.find((d) => d.commitSha === data.spikes[0]!.commitSha));
    expect(await latestCostDate(db, orgId, "mock")).toBe(data.end);
    expect(await latestDeployDate(db, orgId, data.repo)).toBe(data.deploys.at(-1)!.mergedAt.slice(0, 10));
  });

  it("saves analysis results and replaces them on re-run", async () => {
    const reports = await analyze(await loadCostRecords(db, orgId), await loadDeploys(db, orgId, data.repo));
    await saveAnalysis(db, orgId, reports);
    await saveAnalysis(db, orgId, reports);
    expect(await db.costAnomaly.count()).toBe(reports.length);
    const top = await db.attribution.findFirst({ where: { rank: 1, anomaly: { service: "RDS" } }, include: { deploy: true } });
    expect(top?.deploy.commitSha).toBe(data.spikes[0]!.commitSha);
    expect(top?.evidence).toEqual(reports.find((r) => r.anomaly.service === "RDS")!.suspects[0]!.evidence);
  }, 60_000);

  it("keeps workspaces isolated", async () => {
    const user = await db.user.create({ data: { githubId: 99, login: "other" } });
    const other = await createOrganization(db, "Other Co", user.id);
    // Same rows in a second workspace don't collide with or overwrite the first.
    await saveCostRecords(db, other.id, data.costs.slice(0, 10));
    await saveDeploys(db, other.id, data.deploys.slice(0, 2));
    expect(await loadCostRecords(db, other.id)).toHaveLength(10);
    expect(await loadDeploys(db, other.id)).toHaveLength(2);
    expect(await loadCostRecords(db, orgId)).toHaveLength(data.costs.length);
    // Re-running analysis in one workspace leaves the other's results alone.
    await saveAnalysis(db, other.id, []);
    expect(await db.costAnomaly.count({ where: { orgId } })).toBeGreaterThan(0);
    await clearOrgData(db, other.id);
    expect(await db.costRecord.count({ where: { orgId: other.id } })).toBe(0);
    expect(await db.costRecord.count({ where: { orgId } })).toBe(data.costs.length);
  }, 60_000);

  it("clears a workspace's data", async () => {
    await clearOrgData(db, orgId);
    expect(await db.costRecord.count()).toBe(0);
    expect(await db.deploy.count()).toBe(0);
    expect(await db.deployFile.count()).toBe(0);
    expect(await db.costAnomaly.count()).toBe(0);
    expect(await db.attribution.count()).toBe(0);
  });
});
