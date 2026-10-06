import { relative } from "node:path";
import { SERVICES } from "@commitcost/core";
import { loadDailyServiceTotals, type PrismaClient } from "@commitcost/db";
import { bold, dim, renderServiceCharts, renderSpikeTable, usd } from "./render.js";
import { GROUND_TRUTH_PATH, seedMock } from "./seed.js";

/**
 * Phase 1 demo: seed mock data into the local database, read it back, and
 * show what the attribution engine will be asked to find. Phase 5 replaces
 * this with the dashboard.
 */
export async function runDemo(db: PrismaClient): Promise<void> {
  const dataset = await seedMock(db);
  const totals = await loadDailyServiceTotals(db);
  const [costRows, deployRows, fileRows] = await Promise.all([db.costRecord.count(), db.deploy.count(), db.deployFile.count()]);

  const total = totals.reduce((sum, t) => sum + t.amountUsd, 0);
  const days = new Set(totals.map((t) => t.date)).size;

  console.log();
  console.log(bold("CommitCost mock mode") + dim("  (no credentials used)"));
  console.log(`${dataset.start} → ${dataset.end}, ${days} days, repo ${dataset.repo}, seed ${dataset.seed}`);
  console.log(
    `Stored ${costRows.toLocaleString()} cost records (${SERVICES.length} services × app tag), ` +
      `${deployRows} merged PRs (${fileRows} changed files). Total spend ${usd(total)}.`,
  );
  console.log();
  console.log(bold("Daily cost by service, read back from the database"));
  console.log(renderServiceCharts(totals, dataset));
  console.log();
  console.log(bold(`Injected cost changes (ground truth, ${dataset.spikes.length} commits + ${dataset.unexplained.length} blip)`));
  console.log();
  console.log(renderSpikeTable(dataset));
  console.log();
  console.log(dim(`Ground truth written to ${relative(process.cwd(), GROUND_TRUTH_PATH)}.`));
  console.log(dim("Phase 3 adds the attribution engine, which must rank each of these commits #1 on its own."));
  console.log();
}
