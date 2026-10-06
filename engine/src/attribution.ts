import type { Attribution, CostAnomaly, Deploy, Service } from "@commitcost/core";
import { addDays, daysBetween } from "@commitcost/core";
import { analyzeDiff } from "./diff/detectors.js";
import type { DiffFinding } from "./diff/types.js";

export interface AttributionOptions {
  /** Deploys merged this many days before onset (through the onset day) are candidates. */
  lookbackDays: number;
  /** Ranked suspects kept per anomaly. */
  maxSuspects: number;
  weights: { timing: number; relevance: number };
  /** Timing score by whole days between merge and onset (index = days). */
  timingByLag: number[];
}

export const DEFAULT_ATTRIBUTION_OPTIONS: AttributionOptions = {
  lookbackDays: 3,
  maxSuspects: 5,
  weights: { timing: 0.3, relevance: 0.7 },
  timingByLag: [1, 0.9, 0.7, 0.5, 0.35, 0.25, 0.2, 0.15],
};

/**
 * File paths that suggest a service without proving a cost change: weak
 * evidence that only matters when nothing in the diff is conclusive.
 */
const PATH_HINTS: { re: RegExp; services: Service[] }[] = [
  { re: /\.sql$|migrations?\/|\/(db|database|models?|repositor(y|ies)|orm|queries)\/|(repository|model|dao|query)\.\w+$|schema\.prisma$/i, services: ["RDS"] },
  { re: /rds|aurora|postgres|mysql/i, services: ["RDS"] },
  { re: /dynamo/i, services: ["DynamoDB"] },
  { re: /serverless\.ya?ml$|template\.ya?ml$|lambda|\/handlers?\//i, services: ["Lambda"] },
  { re: /\bs3\b|s3\.tf$|bucket|upload|storage/i, services: ["S3"] },
  { re: /\b(ec2|asg|autoscaling|instance|ecs|eks|nodegroup|compute)\b|(ec2|asg|ecs|eks|instances?)\.tf$/i, services: ["EC2"] },
  { re: /cloudfront|cdn|nat|vpc|transfer|replica/i, services: ["DataTransfer"] },
];

export interface ScoredCandidate {
  deploy: Deploy;
  lagDays: number;
  timing: number;
  relevance: number;
  total: number;
  /** Findings that bear on this anomaly's service, strongest first. */
  findings: DiffFinding[];
  /** Files whose path hints at the service, when no finding does. */
  hintedFiles: string[];
}

function mergeDay(d: Deploy): string {
  return d.mergedAt.slice(0, 10);
}

/** Probabilistic OR: several independent weak signals add up, capped at 1. */
function combine(weights: number[]): number {
  return 1 - weights.reduce((p, w) => p * (1 - Math.max(0, Math.min(1, w))), 1);
}

/** How strongly a deploy's diff points at the anomaly's service. 0..1. */
export function relevance(deploy: Deploy, anomaly: CostAnomaly, findings = analyzeDiff(deploy.files)) {
  const matching = findings
    .filter((f) => f.services.includes(anomaly.service))
    .map((f) => ({ f, w: f.confidence * (f.direction === "unknown" || f.direction === anomaly.direction ? 1 : 0.25) }))
    .sort((a, b) => b.w - a.w);

  const hintedFiles = deploy.files.filter((file) => PATH_HINTS.some((h) => h.services.includes(anomaly.service) && h.re.test(file.path))).map((f) => f.path);
  const weights = matching.map((m) => m.w);
  if (hintedFiles.length) weights.push(0.3);

  // Spend concentrated in one `app` tag: code under a matching directory is a bit more likely.
  if (anomaly.tagValue && deploy.files.some((f) => f.path.split("/").includes(anomaly.tagValue!))) weights.push(0.1);

  return { score: combine(weights), findings: matching.map((m) => m.f), hintedFiles };
}

/** Finds and scores deploys that could have caused an anomaly. */
export function scoreCandidates(anomaly: CostAnomaly, deploys: Deploy[], options: Partial<AttributionOptions> = {}): ScoredCandidate[] {
  const opts = { ...DEFAULT_ATTRIBUTION_OPTIONS, ...options };
  const from = addDays(anomaly.onsetDate, -opts.lookbackDays);
  return deploys
    .filter((d) => mergeDay(d) >= from && mergeDay(d) <= anomaly.onsetDate)
    .map((deploy) => {
      const lagDays = daysBetween(mergeDay(deploy), anomaly.onsetDate);
      const timing = opts.timingByLag[Math.min(lagDays, opts.timingByLag.length - 1)]!;
      const rel = relevance(deploy, anomaly);
      const total = opts.weights.timing * timing + opts.weights.relevance * rel.score;
      return { deploy, lagDays, timing, relevance: rel.score, total, findings: rel.findings, hintedFiles: rel.hintedFiles };
    })
    .sort((a, b) => b.total - a.total || a.lagDays - b.lagDays);
}

/**
 * Confidence that the top suspect is the cause. Starts from its score, is cut
 * when a runner-up is close behind, when nothing in the diff relates to the
 * service, and for blips (code changes usually shift cost for good).
 */
export function confidenceFor(ranked: ScoredCandidate[], index: number, anomaly: CostAnomaly): number {
  const c = ranked[index]!;
  let conf = c.total;
  if (index === 0) {
    const gap = c.total - (ranked[1]?.total ?? 0);
    conf *= 0.6 + 0.4 * Math.min(1, gap / 0.3);
  } else {
    conf *= 0.6 * (c.total / ranked[0]!.total);
  }
  if (c.relevance < 0.2) conf = Math.min(conf, 0.25);
  if (!anomaly.persistent) conf *= 0.6;
  return Math.round(conf * 100) / 100;
}

const usd = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export function describeAnomaly(a: CostAnomaly): string {
  const pct = a.baselineUsd > 0 ? ` (${a.deltaUsd >= 0 ? "+" : "-"}${Math.round(Math.abs(a.deltaUsd / a.baselineUsd) * 100)}%)` : "";
  const scope = a.tagValue ? ` in app "${a.tagValue}"` : "";
  const verb = a.direction === "increase" ? "rose" : "fell";
  const impact = a.persistent
    ? `about ${usd(a.estimatedMonthlyImpactUsd)}/month ${a.direction === "increase" ? "extra" : "saved"}`
    : `a one-off ${usd(a.estimatedMonthlyImpactUsd)} that did not persist`;
  return `${a.service} cost${scope} ${verb} ${usd(a.deltaUsd)}/day${pct} starting ${a.onsetDate}, ${impact}.`;
}

/** Plain-English explanation for one suspect, from the heuristics alone. */
export function heuristicExplanation(anomaly: CostAnomaly, c: ScoredCandidate): string {
  const who = `${c.deploy.prNumber ? `PR #${c.deploy.prNumber}` : `Commit ${c.deploy.commitSha.slice(0, 7)}`} "${c.deploy.title}" by @${c.deploy.author}`;
  const when = c.lagDays === 0 ? "was merged the same day" : `was merged ${c.lagDays} day${c.lagDays === 1 ? "" : "s"} before`;
  const top = c.findings[0];
  if (top) {
    const where = `${top.file}${top.line ? `:${top.line}` : ""}`;
    return `${describeAnomaly(anomaly)} ${who} ${when}. ${top.title} (${where}): ${top.why}`;
  }
  if (c.hintedFiles.length) {
    return `${describeAnomaly(anomaly)} ${who} ${when} and touches ${anomaly.service}-related files (${c.hintedFiles.slice(0, 2).join(", ")}), but no specific cost pattern was found in the diff.`;
  }
  return `${describeAnomaly(anomaly)} No change in the window touches code related to ${anomaly.service}; this looks usage-driven. Nearest deploy: ${who}, which ${when}.`;
}

export function toAttributions(anomaly: CostAnomaly, ranked: ScoredCandidate[], maxSuspects = DEFAULT_ATTRIBUTION_OPTIONS.maxSuspects): Attribution[] {
  return ranked.slice(0, maxSuspects).map((c, i) => ({
    anomaly,
    repo: c.deploy.repo,
    commitSha: c.deploy.commitSha,
    prNumber: c.deploy.prNumber,
    title: c.deploy.title,
    evidence: c.findings.slice(0, 3).map((f) => ({ file: f.file, line: f.line, detail: f.title, snippet: f.snippet })),
    rank: i + 1,
    confidence: confidenceFor(ranked, i, anomaly),
    scores: { timing: round(c.timing), relevance: round(c.relevance), total: round(c.total) },
    explanation: heuristicExplanation(anomaly, c),
    explanationSource: "heuristic",
    estimatedMonthlyImpactUsd: anomaly.estimatedMonthlyImpactUsd,
  }));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
