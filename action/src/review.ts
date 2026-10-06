import type { Service } from "@commitcost/core";
import {
  BASIS_LABELS,
  INPUT_SOURCE_LABELS,
  analyzeFile,
  estimateImpact,
  formatInputValue,
  toCostContext,
  type CostContextInput,
  type DiffFinding,
  type FileDiff,
  type ImpactEstimate,
} from "@commitcost/engine";

export const COMMENT_MARKER = "<!-- commitcost:pr-cost-review -->";

export interface Warning extends DiffFinding {
  impact: ImpactEstimate;
}

export interface ReviewOptions {
  minConfidence: number;
  serviceSpend?: Partial<Record<Service, number>>;
  /** Price book, region, usage profile and assumption overrides for the cost model. */
  cost?: CostContextInput;
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
  const ctx = toCostContext({ ...opts.cost, serviceSpend: opts.serviceSpend ?? opts.cost?.serviceSpend });
  return files
    .filter((f) => f.patch && !SKIP.test(f.path))
    .flatMap((f) => analyzeFile(f).map((finding) => ({ finding, patch: f.patch })))
    .filter(({ finding }) => finding.direction === "increase" && finding.confidence >= opts.minConfidence)
    .map(({ finding, patch }) => ({ ...finding, impact: estimateImpact(finding, ctx, patch) }))
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
      `**Estimated impact:** ${w.impact.summary} _(${BASIS_LABELS[w.impact.estimate.basis]})_`,
      "",
      ...renderCalculation(w),
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
    "| # | Change | Where | Estimated impact | Confidence |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...details,
    "",
    `<sub>Checked ${short}. ${pricingNote(warnings)} This comment updates on every push.</sub>`,
  ].join("\n");
}

/** The formula, its inputs with their sources, and the assumptions, folded away under the estimate. */
function renderCalculation(w: Warning): string[] {
  const e = w.impact.estimate;
  if (e.inputs.length === 0 && e.assumptions.length === 0) return [];
  const rows = e.inputs.map((i) => `| ${i.label} | ${formatInputValue(i)} | ${INPUT_SOURCE_LABELS[i.source]}${i.ref ? ` <sub>${i.ref}</sub>` : ""} |`);
  return [
    "<details><summary>How this was calculated</summary>",
    "",
    `\`${e.formula}\``,
    "",
    "| Input | Value | Source |",
    "|---|---|---|",
    ...rows,
    "",
    ...(e.calibration ? [`> ${e.calibration.note} From the diff alone: ${e.calibration.diffOnlyMonthlyUsd >= 0 ? "+" : ""}$${Math.round(e.calibration.diffOnlyMonthlyUsd).toLocaleString("en-US")}/month.`, ""] : []),
    ...(e.assumptions.length ? ["Assumptions:", ...e.assumptions.map((a) => `- ${a}`), ""] : []),
    "</details>",
    "",
  ];
}

function pricingNote(warnings: Warning[]): string {
  const e = warnings[0]?.impact.estimate;
  if (!e) return "";
  const calibrated = warnings.some((w) => w.impact.estimate.basis === "usage-calibrated");
  return `Prices: ${e.priceSource}, ${e.region}.${calibrated ? " Volumes calibrated with your bill." : " No usage data was provided, so volumes come from the diff or stated defaults."}`;
}
