import type { Service } from "@commitcost/core";
import type { CalibrationTable, CostContextInput, FileCostHistory } from "@commitcost/engine";
import type { GitHub } from "./github.js";
import { COMMENT_MARKER, historyFor, renderComment, reviewFiles, type Warning } from "./review.js";

export interface RunInput {
  repo: string;
  prNumber: number;
  headSha: string;
  minConfidence: number;
  serviceSpend?: Partial<Record<Service, number>>;
  cost?: CostContextInput;
  calibration?: CalibrationTable;
  /** Costly files from the cost profile. */
  history?: FileCostHistory[];
  /** A PR with no warnings still gets a comment when it touches a file that added at least this much per month. */
  historyMinUsd?: number;
  dryRun: boolean;
}

export type CommentAction = "created" | "updated" | "skipped-clean" | "dry-run";

export interface RunResult {
  warnings: Warning[];
  history: FileCostHistory[];
  body: string;
  action: CommentAction;
}

/**
 * Reviews one PR and keeps exactly one CommitCost comment on it: created on
 * the first push with findings, edited in place afterwards, and left alone
 * (never created) while the PR is clean.
 */
export async function run(gh: GitHub, input: RunInput): Promise<RunResult> {
  const files = await gh.listPrFiles(input.repo, input.prNumber);
  const diffs = files.filter((f) => f.status !== "removed").map((f) => ({ path: f.filename, patch: f.patch }));
  const warnings = reviewFiles(diffs, { minConfidence: input.minConfidence, serviceSpend: input.serviceSpend, cost: input.cost, calibration: input.calibration });
  // History rides along with any warning; on its own it only speaks up for files that added real money.
  const touched = historyFor(diffs, input.history);
  const history = warnings.length ? touched : touched.filter((h) => h.increaseUsd >= (input.historyMinUsd ?? 1000));
  const body = renderComment(warnings, { repo: input.repo, headSha: input.headSha }, history);
  if (input.dryRun) return { warnings, history, body, action: "dry-run" };

  const existing = (await gh.listComments(input.repo, input.prNumber)).find((c) => c.body?.includes(COMMENT_MARKER));
  if (existing) {
    if (existing.body !== body) await gh.updateComment(input.repo, existing.id, body);
    return { warnings, history, body, action: "updated" };
  }
  if (warnings.length === 0 && history.length === 0) return { warnings, history, body, action: "skipped-clean" };
  await gh.createComment(input.repo, input.prNumber, body);
  return { warnings, history, body, action: "created" };
}
