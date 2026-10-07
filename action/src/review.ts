import type { Service } from "@commitcost/core";
import {
  BASIS_LABELS,
  INPUT_SOURCE_LABELS,
  analyzeFile,
  calibrate,
  estimateImpact,
  fmtUsd,
  formatInputValue,
  toCostContext,
  type CalibratedAmount,
  type CalibrationTable,
  type CostContextInput,
  type DiffFinding,
  type FileCostHistory,
  type FileDiff,
  type ImpactEstimate,
} from "@commitcost/engine";

export const COMMENT_MARKER = "<!-- commitcost:pr-cost-review -->";

export interface Warning extends DiffFinding {
  impact: ImpactEstimate;
  /** The estimate adjusted by what your past cost receipts showed for this check. */
  calibrated?: CalibratedAmount;
}

export interface ReviewOptions {
  minConfidence: number;
  serviceSpend?: Partial<Record<Service, number>>;
  /** Price book, region, usage profile and assumption overrides for the cost model. */
  cost?: CostContextInput;
  /** Per-detector corrections learned from cost receipts. */
  calibration?: CalibrationTable;
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
    .map(({ finding, patch }) => {
      const impact = estimateImpact(finding, ctx, patch);
      return { ...finding, impact, calibrated: calibrate(finding.detector, impact.monthlyUsd, opts.calibration) };
    })
    .sort((a, b) => monthly(b) - monthly(a) || b.confidence - a.confidence);
}

const monthly = (w: Warning) => w.calibrated?.monthlyUsd ?? w.impact.monthlyUsd ?? 0;

/**
 * Files in this PR whose earlier changes raised the bill (from the cost
 * profile's history), biggest first. Shown even when no detector fires:
 * code that has been expensive before deserves a second look.
 */
export function historyFor(files: FileDiff[], history: FileCostHistory[] | undefined, minUsd = 0): FileCostHistory[] {
  if (!history?.length) return [];
  const touched = new Set(files.filter((f) => !SKIP.test(f.path)).map((f) => f.path));
  return history.filter((h) => touched.has(h.path) && h.increaseUsd >= minUsd).sort((a, b) => b.increaseUsd - a.increaseUsd);
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
export function renderComment(warnings: Warning[], ctx: CommentContext, history: FileCostHistory[] = []): string {
  const short = ctx.headSha.slice(0, 7);
  if (warnings.length === 0 && history.length === 0) {
    return `${COMMENT_MARKER}\n### ✅ CommitCost: no cost risks found\n\nThe latest changes (${short}) no longer include the cost-risky patterns flagged earlier.`;
  }
  if (warnings.length === 0) {
    return [
      COMMENT_MARKER,
      "### 📍 CommitCost: this PR changes code that has raised the bill before",
      "",
      "No cost-risky pattern was found in the diff itself.",
      "",
      ...renderHistory(history),
      `<sub>Checked ${short}. This comment updates on every push.</sub>`,
    ].join("\n");
  }

  const rows = warnings.map((w, i) => `| ${i + 1} | ${w.title} | ${link(ctx, w)} | ${impactCell(w)} | ${confidenceLabel(w.confidence)} |`);
  const details = warnings.map((w, i) => {
    const lines = [
      `<details${i === 0 ? " open" : ""}><summary><b>${i + 1}. ${w.title}</b> in ${link(ctx, w)}</summary>`,
      "",
      `**Why it costs money:** ${w.why}`,
      "",
      `**Estimated impact:** ${w.impact.summary} _(${BASIS_LABELS[w.impact.estimate.basis]})_`,
      "",
      ...(w.calibrated ? [`**Adjusted by your cost receipts:** ≈ ${fmtUsd(w.calibrated.monthlyUsd, { sign: true })}/month. ${w.calibrated.note}`, ""] : []),
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
    ...renderHistory(history),
    `<sub>Checked ${short}. ${pricingNote(warnings)} This comment updates on every push.</sub>`,
  ].join("\n");
}

function impactCell(w: Warning): string {
  if (!w.calibrated) return w.impact.summary;
  return `≈ ${fmtUsd(w.calibrated.monthlyUsd, { sign: true })}/month <sub>model ${w.impact.summary}, ×${w.calibrated.factor.toFixed(2)} from receipts</sub>`;
}

/** Past cost increases traced to files this PR touches, with their owners. */
function renderHistory(history: FileCostHistory[]): string[] {
  if (history.length === 0) return [];
  const rows = history.slice(0, 8).map((h) => {
    const past = h.changes
      .slice(0, 3)
      .map((c) => `${c.prNumber ? `#${c.prNumber}` : c.title} ${fmtUsd(c.monthlyUsd, { sign: true })}/mo`)
      .join(", ");
    return `| \`${h.path}\` | ${fmtUsd(h.increaseUsd, { sign: true })}/month | ${past} | ${h.owners.join(" ") || "none"} |`;
  });
  return [
    "<details open><summary><b>Cost history of files in this PR</b></summary>",
    "",
    "Earlier changes to these files were traced to increases that are still on the bill. Worth a look from their owners.",
    "",
    "| File | Added to the bill | By | Owners |",
    "|---|---|---|---|",
    ...rows,
    "</details>",
    "",
  ];
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
