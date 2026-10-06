#!/usr/bin/env tsx
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, ensureCliOrg, enqueueSync, type PrismaClient } from "@commitcost/db";
import { cloudFormationTemplate, GitHubApp, liveSyncDeps, readPlatformConfig, runSyncJob } from "@commitcost/platform";
import { explainerFromEnv, runAnalysis } from "./analyzeCmd.js";
import { loadDotEnv, readSyncConfig } from "./config.js";
import { runDemo } from "./demo.js";
import { renderReports } from "./render.js";
import { seedMock } from "./seed.js";
import { sync } from "./sync.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `Usage: commitcost <command> [--org <slug>]

Commands:
  demo           Seed mock data, run attribution, and check it against the injected spikes
  seed           Generate mock AWS costs and GitHub history into the Demo workspace
  sync           Pull AWS costs and GitHub history using local credentials (.env) into a workspace
  analyze        Detect cost anomalies in a workspace and rank the deploys that caused them
  sync-org       Run a hosted workspace's sync now, through its connected AWS role and GitHub App
  cfn-template   Print the CloudFormation template customers deploy to connect AWS

--org defaults to COMMITCOST_ORG, or "local".`;

const COMMANDS = ["seed", "demo", "sync", "analyze", "sync-org", "cfn-template"];

function orgSlug(argv: string[]): string {
  const i = argv.indexOf("--org");
  return (i >= 0 ? argv[i + 1] : undefined) || process.env.COMMITCOST_ORG || "local";
}

async function findOrg(db: PrismaClient, slug: string) {
  const org = await db.organization.findUnique({ where: { slug } });
  if (!org) throw new Error(`No workspace with slug "${slug}".`);
  return org;
}

async function main(command: string | undefined): Promise<void> {
  if (!command || !COMMANDS.includes(command)) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  loadDotEnv(repoRoot);
  if (command === "cfn-template") {
    console.log(JSON.stringify(cloudFormationTemplate({ principalArn: process.env.COMMITCOST_AWS_PRINCIPAL_ARN }), null, 2));
    return;
  }
  const db = createClient();
  const slug = orgSlug(process.argv.slice(3));
  try {
    if (command === "seed") {
      const dataset = await seedMock(db);
      console.log(
        `Seeded ${dataset.costs.length} cost records and ${dataset.deploys.length} deploys ` +
          `(${dataset.start} → ${dataset.end}) with ${dataset.spikes.length} injected cost changes.`,
      );
    } else if (command === "demo") {
      if (!(await runDemo(db))) process.exitCode = 1;
    } else if (command === "sync") {
      const config = readSyncConfig();
      const org = await ensureCliOrg(db, slug);
      await sync(db, org.id, config, resolve(repoRoot, ".commitcost/cache"));
      console.log(`Done. Run \`npm run analyze -- --org ${org.slug}\` next.`);
    } else if (command === "sync-org") {
      const org = await findOrg(db, slug);
      const config = readPlatformConfig();
      const run = await enqueueSync(db, org.id, "manual");
      if (run.status !== "queued") throw new Error("A sync is already running for this workspace.");
      await db.syncRun.update({ where: { id: run.id }, data: { status: "running", startedAt: new Date(), workerId: "cli" } });
      const deps = liveSyncDeps({ days: config.sync.days, githubApp: config.github ? new GitHubApp(config.github) : null, explainer: explainerFromEnv() });
      await runSyncJob(db, run, deps);
      const done = await db.syncRun.findUniqueOrThrow({ where: { id: run.id } });
      console.log(done.log);
      if (done.status === "failed") process.exitCode = 1;
    } else {
      const org = await findOrg(db, slug);
      const reports = await runAnalysis(db, org.id, explainerFromEnv());
      console.log(renderReports(reports));
    }
  } finally {
    await db.$disconnect();
  }
}

main(process.argv[2]).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
