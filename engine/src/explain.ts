import type { Attribution, Deploy } from "@commitcost/core";
import { describeAnomaly } from "./attribution.js";

export interface ExplanationInput {
  attribution: Attribution;
  deploy: Deploy;
}

/**
 * Optional LLM step that rewrites the top suspect's explanation from the diff
 * and cost context. Pluggable: implement this for any provider. The engine
 * works without one, and falls back to the heuristic text if it fails.
 */
export interface Explainer {
  readonly name: string;
  explain(input: ExplanationInput): Promise<string>;
}

/** The prompt any LLM explainer can use. Diffs are capped to keep cost bounded. */
export function buildExplanationPrompt({ attribution, deploy }: ExplanationInput, maxPatchChars = 12_000): string {
  let budget = maxPatchChars;
  const files = deploy.files
    .map((f) => {
      const patch = (f.patch ?? "(no patch available)").slice(0, Math.max(0, budget));
      budget -= patch.length;
      return `--- ${f.path} (+${f.additions} -${f.deletions})\n${patch}`;
    })
    .join("\n\n");
  const evidence = attribution.evidence.map((e) => `- ${e.file}${e.line ? `:${e.line}` : ""}: ${e.detail}`).join("\n") || "- none found by heuristics";

  return `A cloud cost change was detected and attributed to a code change. Explain in 2-3 plain sentences, for the engineer who merged it, why this change most likely caused the cost change. Name the specific code and the AWS billing mechanism. If the diff doesn't plausibly explain the cost change, say so plainly. No preamble, no markdown.

Cost change: ${describeAnomaly(attribution.anomaly)}
Suspect: ${deploy.prNumber ? `PR #${deploy.prNumber}` : `commit ${deploy.commitSha.slice(0, 7)}`} "${deploy.title}" by @${deploy.author}, merged ${deploy.mergedAt}.
Heuristic confidence: ${Math.round(attribution.confidence * 100)}%
Heuristic evidence:
${evidence}

<diff>
${files}
</diff>`;
}
