"use server";

import { historyFor, renderComment, reviewFiles, type Warning } from "@commitcost/action";
import type { FileCostHistory } from "@commitcost/engine";
import { currentCostContext } from "@/lib/cost";
import { parseGitDiff } from "@/lib/diffText";
import { getLearnedProfile } from "@/lib/history";

export interface CheckResult {
  files: string[];
  warnings: Warning[];
  history: FileCostHistory[];
  comment: string;
  error?: string;
}

export async function checkDiff(_prev: CheckResult | null, form: FormData): Promise<CheckResult> {
  const text = String(form.get("diff") ?? "");
  if (text.length > 2_000_000) return { files: [], warnings: [], history: [], comment: "", error: "Diff is too large (over 2 MB)." };
  const files = parseGitDiff(text);
  if (files.length === 0) return { files: [], warnings: [], history: [], comment: "", error: "No hunks found. Paste the output of `git diff` or a PR's .diff." };
  const minConfidence = Number(form.get("minConfidence") ?? 0.6);
  // Priced with the latest two weeks of usage, as the Action is with an exported cost profile.
  // ...and adjusted by the corrections and file history the cost profile would carry.
  const [ctx, learned] = await Promise.all([currentCostContext(), getLearnedProfile()]);
  const warnings = reviewFiles(files, {
    minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0.6,
    cost: { prices: ctx.prices, usage: ctx.usage },
    calibration: learned.calibration,
  });
  const history = historyFor(files, learned.history);
  return {
    files: files.map((f) => f.path),
    warnings,
    history,
    comment: renderComment(warnings, { repo: "your-org/your-repo", headSha: "0000000" }, history),
  };
}
