/**
 * Domain types shared by every package. These are plain data shapes with no
 * persistence concerns, so the engine can stay pure and providers for other
 * clouds or VCS hosts can be added without touching it.
 */

/** Calendar day in UTC, formatted YYYY-MM-DD. Cost data is daily granularity. */
export type IsoDate = string;

export type CloudProvider = "aws";

/** Normalized service names. Providers map their native names onto these. */
export const SERVICES = ["EC2", "RDS", "Lambda", "S3", "DynamoDB", "DataTransfer"] as const;
export type KnownService = (typeof SERVICES)[number];
/** Spend from services CommitCost doesn't model separately is summed into "Other". */
export type Service = KnownService | "Other";

export type CostSource = "mock" | "aws-cost-explorer";

/** One day of spend for one service and (optionally) one cost-allocation tag value. */
export interface CostRecord {
  date: IsoDate;
  provider: CloudProvider;
  /** Cloud account id. Mock data uses a fixed fake id. */
  accountId: string;
  service: Service;
  /** Cost-allocation tag key, e.g. "app". Empty string when not grouped by tag. */
  tagKey: string;
  /** Tag value, e.g. "api". Empty string for untagged spend. */
  tagValue: string;
  amountUsd: number;
  source: CostSource;
}

export interface DeployFile {
  path: string;
  additions: number;
  deletions: number;
  /** Unified diff hunk(s) for this file, when available. */
  patch?: string;
}

/** A change that reached the default branch (a merged PR or a direct push). */
export interface Deploy {
  repo: string;
  commitSha: string;
  prNumber: number | null;
  /** ISO-8601 timestamp of the merge to the default branch. */
  mergedAt: string;
  author: string;
  title: string;
  body?: string;
  url?: string;
  files: DeployFile[];
}

export type AnomalyDirection = "increase" | "decrease";

/** A significant deviation in a service's daily cost from its baseline. */
export interface CostAnomaly {
  service: Service;
  /** Tag value most of the change is concentrated in, if one dominates. */
  tagValue?: string;
  /** First day the cost deviated. */
  onsetDate: IsoDate;
  /** Consecutive days flagged, starting at onset. */
  durationDays: number;
  /** Expected cost on the onset day (weekday-aware rolling median). */
  baselineUsd: number;
  /** Average observed cost over the flagged days. */
  observedUsd: number;
  /** Average observed - baseline per flagged day. */
  deltaUsd: number;
  direction: AnomalyDirection;
  /** Largest deviation in robust standard units (MAD-scaled). */
  score: number;
  /** True when cost stayed at the new level after the flagged run (a step
   * change), false for a blip that returned to baseline. */
  persistent: boolean;
  /** deltaUsd * 30 for persistent changes; the one-off excess for blips. */
  estimatedMonthlyImpactUsd: number;
}

/** Breakdown of how a suspect deploy was scored. All components are 0..1. */
export interface ScoreBreakdown {
  timing: number;
  relevance: number;
  /** Weighted combination used for ranking. */
  total: number;
}

/** One suspect deploy for one anomaly. */
export interface Attribution {
  anomaly: CostAnomaly;
  /** "owner/name". An organization can track several repos. */
  repo: string;
  commitSha: string;
  prNumber: number | null;
  title: string;
  /** Strongest evidence in the diff, e.g. "services/api/src/routes/orders.ts:43". */
  evidence: { file: string; line?: number; detail: string; snippet?: string }[];
  /** 1 = most likely cause. */
  rank: number;
  /** 0..1 */
  confidence: number;
  scores: ScoreBreakdown;
  explanation: string;
  /** Who wrote the explanation: the heuristic engine or an LLM provider. */
  explanationSource: "heuristic" | "llm";
  /** deltaUsd * 30 */
  estimatedMonthlyImpactUsd: number;
}
