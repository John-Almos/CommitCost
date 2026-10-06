"use server";

import { renderComment, reviewFiles, type Warning } from "@commitcost/action";
import { currentCostContext } from "@/lib/cost";
import { parseGitDiff } from "@/lib/diffText";

export interface CheckResult {
  files: string[];
  warnings: Warning[];
  comment: string;
  error?: string;
}

export async function checkDiff(_prev: CheckResult | null, form: FormData): Promise<CheckResult> {
  const text = String(form.get("diff") ?? "");
  if (text.length > 2_000_000) return { files: [], warnings: [], comment: "", error: "Diff is too large (over 2 MB)." };
  const files = parseGitDiff(text);
  if (files.length === 0) return { files: [], warnings: [], comment: "", error: "No hunks found. Paste the output of `git diff` or a PR's .diff." };
  const minConfidence = Number(form.get("minConfidence") ?? 0.6);
  // Priced with the latest two weeks of usage, as the Action is with an exported cost profile.
  const ctx = await currentCostContext();
  const warnings = reviewFiles(files, { minConfidence: Number.isFinite(minConfidence) ? minConfidence : 0.6, cost: { prices: ctx.prices, usage: ctx.usage } });
  return {
    files: files.map((f) => f.path),
    warnings,
    comment: renderComment(warnings, { repo: "your-org/your-repo", headSha: "0000000" }),
  };
}
