import { relative } from "node:path";
import { SERVICES, type CostAnomaly } from "@commitcost/core";
import { loadDailyServiceTotals, type PrismaClient } from "@commitcost/db";
import { runAnalysis } from "./analyzeCmd.js";
import { bold, dim, green, red, renderReports, renderServiceCharts, renderSpikeTable, usd } from "./render.js";
import { GROUND_TRUTH_PATH, seedMock } from "./seed.js";

/**
 * Mock demo: seed mock data, run anomaly detection and attribution over what
 * was stored, and check the results against the injected ground truth.
 * `npm run demo` runs this check, then starts the dashboard on the same data.
 */
export async function runDemo(db: PrismaClient): Promise<boolean> {
  const dataset = await seedMock(db);
  const totals = await loadDailyServiceTotals(db);
  const [costRows, deployRows] = await Promise.all([db.costRecord.count(), db.deploy.count()]);
  const total = totals.reduce((sum, t) => sum + t.amountUsd, 0);

  console.log();
  console.log(bold("CommitCost mock mode") + dim("  (no credentials used)"));
  console.log(`${dataset.start} → ${dataset.end}, repo ${dataset.repo}, seed ${dataset.seed}`);
  console.log(`Stored ${costRows.toLocaleString()} cost records (${SERVICES.length} services × app tag) and ${deployRows} merged PRs. Total spend ${usd(total)}.`);
  console.log();
  console.log(bold("Daily cost by service"));
  console.log(renderServiceCharts(totals, dataset));
  console.log();

  // No LLM in the demo: it must run with zero credentials.
  const reports = await runAnalysis(db, dataset.repo);
  // An anomaly matches an injected change on the same service within 2 days of its onset.
  const near = (a: CostAnomaly, date: string) => Math.abs(Date.parse(a.onsetDate) - Date.parse(date)) <= 2 * 86_400_000;
  const expectedCause = (a: CostAnomaly) =>
    dataset.spikes.find((s) => s.effects.some((e) => e.service === a.service) && near(a, s.onsetDate))?.commitSha;

  console.log(bold(`Detected ${reports.length} anomalies and ranked suspect PRs`));
  console.log();
  console.log(renderReports(reports, expectedCause));
  console.log();

  // Score against ground truth: every injected change must be found and ranked #1.
  const missed: string[] = [];
  for (const spike of dataset.spikes) {
    for (const effect of spike.effects) {
      const found = reports.find((r) => r.anomaly.service === effect.service && near(r.anomaly, spike.onsetDate));
      if (!found || found.suspects[0]?.commitSha !== spike.commitSha) missed.push(`${spike.key} (${effect.service})`);
    }
  }
  const blip = dataset.unexplained[0];
  const blipReport = blip && reports.find((r) => r.anomaly.service === blip.service && r.anomaly.onsetDate === blip.date);
  const blipOk = !blip || !blipReport || (blipReport.suspects[0]?.confidence ?? 0) < 0.3;

  const checks = dataset.spikes.reduce((n, s) => n + s.effects.length, 0);
  console.log(bold("Ground truth check"));
  console.log(
    missed.length === 0
      ? green(`✓ All ${checks} injected cost changes detected with the causing PR ranked #1.`)
      : red(`✗ ${missed.length} of ${checks} injected changes not attributed correctly: ${missed.join(", ")}`),
  );
  console.log(blipOk ? green("✓ The crawler blip (no code cause) is reported with low confidence.") : red("✗ The no-cause blip was attributed with high confidence."));
  console.log();
  console.log(dim(`Ground truth: ${relative(process.cwd(), GROUND_TRUTH_PATH)}. Results are stored for the dashboard (npm run dashboard, http://localhost:3000).`));
  console.log();
  return missed.length === 0 && blipOk;
}
