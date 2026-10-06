#!/usr/bin/env tsx
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendSyncLog, claimNextSync, createClient, enqueueDueSyncs, failStaleSyncs, finishSync, type PrismaClient, type SyncRun } from "@commitcost/db";
import { readPlatformConfig } from "./config.js";
import { explainerFromEnv } from "./explainer.js";
import { GitHubApp } from "./githubApp.js";
import { liveSyncDeps, syncOrganization, type SyncDeps } from "./syncOrg.js";

/** A run still "running" after this long belongs to a worker that died. */
const STALE_MS = 60 * 60_000;
const POLL_MS = 15_000;
const SCHEDULE_EVERY_MS = 60_000;

/** Runs one claimed job to completion and records the outcome. Never throws. */
export async function runSyncJob(db: PrismaClient, run: SyncRun, deps: SyncDeps): Promise<void> {
  const log = (line: string) => appendSyncLog(db, run.id, `${new Date().toISOString().slice(11, 19)} ${line}`);
  try {
    const s = await syncOrganization(db, run.orgId, deps, log);
    const failedAll = s.errors.length > 0 && s.costRecords === 0 && s.deploys === 0;
    await finishSync(db, run.id, failedAll ? s.errors.join("\n") : undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(`Failed: ${msg}`).catch(() => {});
    await finishSync(db, run.id, msg);
  }
}

/** Claims and runs queued jobs until none are left. Returns how many ran. */
export async function drainQueue(db: PrismaClient, deps: SyncDeps, workerId: string): Promise<number> {
  let n = 0;
  for (let run = await claimNextSync(db, workerId); run; run = await claimNextSync(db, workerId)) {
    await runSyncJob(db, run, deps);
    n++;
  }
  return n;
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    process.loadEnvFile(resolve(root, ".env"));
  } catch {
    // No .env file: settings come from the environment.
  }
  const config = readPlatformConfig();
  const db = createClient();
  const deps = liveSyncDeps({
    days: config.sync.days,
    githubApp: config.github ? new GitHubApp(config.github) : null,
    explainer: explainerFromEnv(),
  });
  const workerId = `${hostname()}:${process.pid}`;
  const once = process.argv.includes("--once");
  const intervalMs = config.sync.intervalHours * 3_600_000;
  console.log(`CommitCost worker ${workerId}: syncing each connected workspace every ${config.sync.intervalHours}h${once ? " (single pass)" : ""}.`);

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));

  let lastSchedule = 0;
  do {
    if (Date.now() - lastSchedule >= SCHEDULE_EVERY_MS) {
      lastSchedule = Date.now();
      const stale = await failStaleSyncs(db, STALE_MS);
      if (stale) console.log(`Marked ${stale} abandoned run(s) as failed.`);
      const due = await enqueueDueSyncs(db, intervalMs);
      if (due.length) console.log(`Queued scheduled syncs for ${due.length} workspace(s).`);
    }
    const ran = await drainQueue(db, deps, workerId);
    if (ran) console.log(`Finished ${ran} sync job(s).`);
    if (!once && !stopping) await new Promise((r) => setTimeout(r, POLL_MS));
  } while (!once && !stopping);
  await db.$disconnect();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
