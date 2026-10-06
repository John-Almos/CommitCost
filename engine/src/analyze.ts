import type { Attribution, CostAnomaly, CostRecord, Deploy } from "@commitcost/core";
import { detectAnomalies, type AnomalyOptions } from "./anomaly.js";
import { DEFAULT_ATTRIBUTION_OPTIONS, scoreCandidates, toAttributions, type AttributionOptions } from "./attribution.js";
import type { Explainer } from "./explain.js";

export interface AnalyzeOptions {
  anomaly?: Partial<AnomalyOptions>;
  attribution?: Partial<AttributionOptions>;
  /** Optional LLM explainer for the top suspect of each anomaly. */
  explainer?: Explainer;
  /** Called when the explainer fails; the heuristic text is kept. */
  onExplainerError?: (err: unknown) => void;
}

export interface AnomalyReport {
  anomaly: CostAnomaly;
  /** Ranked suspects; empty when nothing merged in the lookback window. */
  suspects: Attribution[];
}

/** Detects anomalies and ranks suspect deploys for each. */
export async function analyze(costs: CostRecord[], deploys: Deploy[], options: AnalyzeOptions = {}): Promise<AnomalyReport[]> {
  const attributionOpts = { ...DEFAULT_ATTRIBUTION_OPTIONS, ...options.attribution };
  const byKey = new Map(deploys.map((d) => [`${d.repo}@${d.commitSha}`, d]));
  const reports: AnomalyReport[] = [];

  for (const anomaly of detectAnomalies(costs, options.anomaly)) {
    const ranked = scoreCandidates(anomaly, deploys, attributionOpts);
    const suspects = toAttributions(anomaly, ranked, attributionOpts.maxSuspects);

    const top = suspects[0];
    if (options.explainer && top && top.confidence >= 0.3) {
      try {
        const text = await options.explainer.explain({ attribution: top, deploy: byKey.get(`${top.repo}@${top.commitSha}`)! });
        if (text.trim()) {
          top.explanation = text.trim();
          top.explanationSource = "llm";
        }
      } catch (err) {
        options.onExplainerError?.(err);
      }
    }
    reports.push({ anomaly, suspects });
  }
  return reports;
}
