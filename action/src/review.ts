import type { Service } from "@commitcost/core";
import { analyzeFile, estimateImpact, type DiffFinding, type FileDiff, type ImpactContext, type ImpactEstimate } from "@commitcost/engine";

export const COMMENT_MARKER = "<!-- commitcost:pr-cost-review -->";

export interface Warning extends DiffFinding {
  impact: ImpactEstimate;
}

export interface ReviewOptions {
  minConfidence: number;
  serviceSpend?: Partial<Record<Service, number>>;
}

export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = { minConfidence: 0.6 };

/** Generated, vendored and test files rarely run in production. */
const SKIP = /(^|\/)(node_modules|vendor|dist|build|\.next|coverage)\/|\.(min\.js|lock|snap)$|package-lock\.json$|(^|\/)(__tests__|tests?|spec|fixtures?)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$/;

/**
 * Reviews a PR's changed files for cost-risky patterns. Only increases at or
 * above the confidence threshold are kept, so the comment stays quiet unless
 * there's something worth a look.
 */
export function reviewFiles(files: FileDiff[], options: Partial<ReviewOptions> = {}): Warning[] {
  const opts = { ...DEFAULT_REVIEW_OPTIONS, ...options };
  const ctx: ImpactContext = { serviceSpend: opts.serviceSpend };
  return files
    .filter((f) => f.patch && !SKIP.test(f.path))
    .flatMap((f) => analyzeFile(f))
    .filter((f) => f.direction === "increase" && f.confidence >= opts.minConfidence)
    .map((f) => ({ ...f, impact: estimateImpact(f, ctx) }))
    .sort((a, b) => (b.impact.monthlyUsd ?? 0) - (a.impact.monthlyUsd ?? 0) || b.confidence - a.confidence);
}

export interface CommentContext {
  repo: string;
  headSha: string;
}

function link(ctx: CommentContext, w: Warning): string {
  const where = `${w.file}${w.line ? `:${w.line}` : ""}`;
  // Removed code lives in the base commit, so only link lines in the new file.
  if (w.side === "old" || !w.line) return `\`${where}\``;
  return `[\`${where}\`](https://github.com/${ctx.repo}/blob/${ctx.headSha}/${w.file.split("/").map(encodeURIComponent).join("/")}#L${w.line})`;
}

const confidenceLabel = (c: number) => (c >= 0.8 ? "high" : c >= 0.6 ? "medium" : "low");

/** One consolidated comment. Re-rendered and edited in place on every push. */
export function renderComment(warnings: Warning[], ctx: CommentContext): string {
  const short = ctx.headSha.slice(0, 7);
  if (warnings.length === 0) {
    return `${COMMENT_MARKER}\n### ✅ CommitCost: no cost risks found\n\nThe latest changes (${short}) no longer include the cost-risky patterns flagged earlier.`;
  }

  const rows = warnings.map((w, i) => `| ${i + 1} | ${w.title} | ${link(ctx, w)} | ${w.impact.summary} | ${confidenceLabel(w.confidence)} |`);
  const details = warnings.map((w, i) => {
    const lines = [
      `<details${i === 0 ? " open" : ""}><summary><b>${i + 1}. ${w.title}</b> in ${link(ctx, w)}</summary>`,
      "",
      `**Why it costs money:** ${w.why}`,
      "",
      `**Rough impact:** ${w.impact.summary}${w.impact.assumptions ? `. _Assumes: ${w.impact.assumptions}_` : ""}`,
      "",
      `**Suggested fix:** ${w.suggestion}`,
      "",
      "```diff",
      w.snippet,
      "```",
      "</details>",
    ];
    return lines.join("\n");
  });

  return [
    COMMENT_MARKER,
    `### 💸 CommitCost: ${warnings.length} possible cost increase${warnings.length === 1 ? "" : "s"} in this PR`,
    "",
    "| # | Change | Where | Rough impact | Confidence |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...details,
    "",
    `<sub>Checked ${short}. Estimates are order-of-magnitude at us-east-1 on-demand prices. This comment updates on every push.</sub>`,
  ].join("\n");
}
