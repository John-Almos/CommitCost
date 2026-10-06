import type { Service } from "@commitcost/core";

export type DetectorId =
  | "query-in-loop"
  | "removed-cache"
  | "removed-batching"
  | "compute-size"
  | "capacity-increase"
  | "lambda-config"
  | "schedule-frequency"
  | "cross-region-transfer"
  | "s3-lifecycle-removed"
  | "hot-path-logging";

export type ChangeDirection = "increase" | "decrease" | "unknown";

/** A cost-relevant pattern found in a diff. Shared by attribution (Phase 3)
 * and the pre-merge PR warnings (Phase 4). */
export interface DiffFinding {
  detector: DetectorId;
  file: string;
  /** Line in the new file, or in the old file when `side` is "old" (removed code). */
  line?: number;
  side: "new" | "old";
  /** CommitCost services whose bill this would move. Empty when the cost lands elsewhere. */
  services: Service[];
  /** Human name for where the money goes, e.g. "RDS read load" or "CloudWatch Logs ingestion". */
  costArea: string;
  direction: ChangeDirection;
  /** 0..1: how sure we are this pattern changes cost. */
  confidence: number;
  title: string;
  why: string;
  suggestion: string;
  snippet: string;
  /** Multiplier on the affected resource's cost when the diff states both values. */
  costRatio?: number;
  assumptions?: string;
}

export interface FileDiff {
  path: string;
  patch?: string;
}
