import { loadCostRecords, loadDeploys, saveAnalysis, type PrismaClient } from "@commitcost/db";
import { analyze, type AnomalyReport, type Explainer } from "@commitcost/engine";
import { AnthropicExplainer } from "@commitcost/providers";

/** The LLM step is opt-in: COMMITCOST_LLM=anthropic plus Anthropic credentials. */
export function explainerFromEnv(env: NodeJS.ProcessEnv = process.env): Explainer | undefined {
  const choice = env.COMMITCOST_LLM?.toLowerCase();
  if (!choice || choice === "none") return undefined;
  if (choice === "anthropic") return new AnthropicExplainer({ model: env.COMMITCOST_LLM_MODEL || undefined });
  throw new Error(`Unknown COMMITCOST_LLM "${env.COMMITCOST_LLM}". Supported: anthropic, none.`);
}

/** Runs detection + attribution over what's stored and saves the results. */
export async function runAnalysis(db: PrismaClient, repo: string | undefined, explainer?: Explainer): Promise<AnomalyReport[]> {
  const [costs, deploys] = await Promise.all([loadCostRecords(db), loadDeploys(db, repo)]);
  if (costs.length === 0) throw new Error("No cost data stored yet. Run `npm run seed` (mock) or `npm run sync` (real) first.");
  const reports = await analyze(costs, deploys, {
    explainer,
    onExplainerError: (err) => console.warn(`LLM explanation failed, using heuristic text: ${err instanceof Error ? err.message : err}`),
  });
  const repos = repo ? [repo] : [...new Set(deploys.map((d) => d.repo))];
  // Stored attributions point at deploys by repo; one repo per database for the MVP.
  await saveAnalysis(db, reports, repos[0] ?? "");
  return reports;
}
