#!/usr/bin/env tsx
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@commitcost/db";
import { explainerFromEnv, runAnalysis } from "./analyzeCmd.js";
import { loadDotEnv, readSyncConfig } from "./config.js";
import { runDemo } from "./demo.js";
import { renderReports } from "./render.js";
import { seedMock } from "./seed.js";
import { sync } from "./sync.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `Usage: commitcost <command>

Commands:
  demo      Seed mock data, run attribution, and check it against the injected spikes
  seed      Generate mock AWS costs and GitHub history and store them locally
  sync      Pull real AWS costs (Cost Explorer) and GitHub history into the database
  analyze   Detect cost anomalies in stored data and rank the deploys that caused them`;

async function main(command: string | undefined): Promise<void> {
  if (!command || !["seed", "demo", "sync", "analyze"].includes(command)) {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  loadDotEnv(repoRoot);
  const db = createClient();
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
      await sync(db, config, resolve(repoRoot, ".commitcost/cache"));
      console.log("Done. Run `npm run analyze` next.");
    } else {
      const reports = await runAnalysis(db, process.env.GITHUB_REPO || undefined, explainerFromEnv());
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
