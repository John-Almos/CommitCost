import { loadCostRecords, loadDeploys, saveAnalysis, type PrismaClient } from "@commitcost/db";
import { analyze, type AnomalyReport, type Explainer } from "@commitcost/engine";

export { explainerFromEnv } from "@commitcost/platform";

/** Runs detection + attribution over one workspace's stored data and saves the results. */
export async function runAnalysis(db: PrismaClient, orgId: string, explainer?: Explainer): Promise<AnomalyReport[]> {
  const [costs, deploys] = await Promise.all([loadCostRecords(db, orgId), loadDeploys(db, orgId)]);
  if (costs.length === 0) throw new Error("No cost data stored yet. Run `npm run seed` (mock) or `npm run sync` (real) first.");
  const reports = await analyze(costs, deploys, {
    explainer,
    onExplainerError: (err) => console.warn(`LLM explanation failed, using heuristic text: ${err instanceof Error ? err.message : err}`),
  });
  await saveAnalysis(db, orgId, reports);
  return reports;
}
