#!/usr/bin/env tsx
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@commitcost/db";
import { explainerFromEnv, runAnalysis } from "./analyzeCmd.js";
import { loadDotEnv, readSyncConfig } from "./config.js";
import { runDemo } from "./demo.js";
import { fixCommand, mapCommand, receiptsCommand } from "./history.js";
import { exportProfile, localPriceBook, renderProfile } from "./profile.js";
import { renderReports } from "./render.js";
import { seedMock } from "./seed.js";
import { sync } from "./sync.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `Usage: commitcost <command>

Commands:
  demo      Seed mock data, run attribution, and check it against the injected spikes
  seed      Generate mock AWS costs and GitHub history and store them locally
  sync      Pull real AWS costs (Cost Explorer) and GitHub history into the database
  analyze   Detect cost anomalies in stored data and rank the deploys that caused them
  profile   Write your measured usage, effective rates, learned corrections and costly files to a
            cost profile for the GitHub Action (default .commitcost/cost-profile.json; pass a path to change it)
  receipts  Compare each merged PR's pre-merge estimate with what the bill measured
            (--post adds the receipt as a comment on the PR; --all lists every receipt)
  map       Show attributed cost by directory, file and CODEOWNERS owner
  fix       Write a partial revert of the lines behind a PR's cost increase: fix <pr-number|sha> [out.patch]`;

async function main(command: string | undefined): Promise<void> {
  if (!command || !["seed", "demo", "sync", "analyze", "profile", "receipts", "map", "fix"].includes(command)) {
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
    } else if (command === "profile") {
      const out = resolve(process.argv[3] ?? resolve(repoRoot, ".commitcost/cost-profile.json"));
      const file = await exportProfile(db, out);
      if (file.usage) console.log(renderProfile(file.usage, localPriceBook().name));
      console.log(`\nLearned from history: ${Object.keys(file.calibration ?? {}).length} check correction(s), ${file.history?.length ?? 0} file(s) with cost history.`);
      console.log(`\nWrote ${out}. Commit it (or upload it in CI) and pass it to the Action as \`cost-profile\`.`);
    } else if (command === "receipts") {
      await receiptsCommand(db, process.argv.slice(3));
    } else if (command === "map") {
      await mapCommand(db);
    } else if (command === "fix") {
      if (!(await fixCommand(db, process.argv.slice(3)))) process.exitCode = 1;
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
