import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMockDataset } from "@commitcost/providers";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearMockData, loadDailyServiceTotals, saveCostRecords, saveDeploys } from "./repository.js";

const dbDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "commitcost-db-"));
const url = `file:${join(tmp, "test.db")}`;
const data = generateMockDataset({ endDate: "2026-10-05" });
let db: PrismaClient;

beforeAll(() => {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"], {
    cwd: dbDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  db = new PrismaClient({ datasources: { db: { url } } });
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(tmp, { recursive: true, force: true });
});

describe("repository", () => {
  it("round-trips mock costs and deploys", async () => {
    await saveCostRecords(db, data.costs);
    await saveDeploys(db, data.deploys);

    expect(await db.costRecord.count()).toBe(data.costs.length);
    expect(await db.deploy.count()).toBe(data.deploys.length);

    const spike = data.spikes[0]!;
    const stored = await db.deploy.findUnique({
      where: { repo_commitSha: { repo: data.repo, commitSha: spike.commitSha } },
      include: { files: true },
    });
    expect(stored?.title).toBe(spike.title);
    expect(stored?.files.map((f) => f.path)).toContain("services/api/src/routes/orders.ts");
  }, 60_000);

  it("sums tag rows into daily service totals", async () => {
    const totals = await loadDailyServiceTotals(db);
    expect(totals).toHaveLength(90 * 6);
    const expected = data.costs
      .filter((r) => r.date === "2026-09-01" && r.service === "EC2")
      .reduce((sum, r) => sum + r.amountUsd, 0);
    const got = totals.find((t) => t.date === "2026-09-01" && t.service === "EC2")!.amountUsd;
    expect(got).toBeCloseTo(expected, 2);
  });

  it("is idempotent on re-save", async () => {
    await saveCostRecords(db, data.costs.slice(0, 50));
    await saveDeploys(db, data.deploys.slice(0, 5));
    expect(await db.costRecord.count()).toBe(data.costs.length);
    expect(await db.deploy.count()).toBe(data.deploys.length);
    const files = await db.deployFile.count();
    expect(files).toBe(data.deploys.reduce((n, d) => n + d.files.length, 0));
  }, 60_000);

  it("clears mock data", async () => {
    await clearMockData(db, data.repo);
    expect(await db.costRecord.count()).toBe(0);
    expect(await db.deploy.count()).toBe(0);
    expect(await db.deployFile.count()).toBe(0);
  });
});
