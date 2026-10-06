import type { Service } from "@commitcost/core";
import type { CostContextInput } from "@commitcost/engine";
import type { GitHub } from "./github.js";
import { COMMENT_MARKER, renderComment, reviewFiles, type Warning } from "./review.js";

export interface RunInput {
  repo: string;
  prNumber: number;
  headSha: string;
  minConfidence: number;
  serviceSpend?: Partial<Record<Service, number>>;
  cost?: CostContextInput;
  dryRun: boolean;
}

export type CommentAction = "created" | "updated" | "skipped-clean" | "dry-run";

export interface RunResult {
  warnings: Warning[];
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
  const warnings = reviewFiles(
    files.filter((f) => f.status !== "removed").map((f) => ({ path: f.filename, patch: f.patch })),
    { minConfidence: input.minConfidence, serviceSpend: input.serviceSpend, cost: input.cost },
  );
  const body = renderComment(warnings, { repo: input.repo, headSha: input.headSha });
  if (input.dryRun) return { warnings, body, action: "dry-run" };

  const existing = (await gh.listComments(input.repo, input.prNumber)).find((c) => c.body?.includes(COMMENT_MARKER));
  if (existing) {
    if (existing.body !== body) await gh.updateComment(input.repo, existing.id, body);
    return { warnings, body, action: "updated" };
  }
  if (warnings.length === 0) return { warnings, body, action: "skipped-clean" };
  await gh.createComment(input.repo, input.prNumber, body);
  return { warnings, body, action: "created" };
}
