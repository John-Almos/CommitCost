import type { Deploy, IsoDate, Service } from "@commitcost/core";
import { daysBetween } from "@commitcost/core";
import type { PricedFinding } from "./cost/change.js";
import type { DetectorId } from "./diff/types.js";

/**
 * Cost receipts: after a change merges and the bill has settled, compare what
 * the PR check predicted with what the bill measured. Receipts are how the
 * cost model gets checked against reality, and the per-detector corrections
 * learned from them feed back into the next PR check.
 */

/** How a prediction compared with the bill. */
export type ReceiptVerdict =
  /** Measured within 0.67×–1.5× of the prediction. */
  | "on-target"
  /** The bill moved more than predicted. */
  | "under"
  /** The bill moved less than predicted. */
  | "over"
  /** Flagged before merge without a dollar amount; the bill moved the predicted way. */
  | "flagged"
  /** The bill moved the opposite way from the prediction. */
  | "wrong-direction"
  /** Predicted a change, the bill showed no detectable change after it settled. */
  | "no-effect"
  /** The bill moved and was attributed to this change, but the PR check predicted nothing for it. */
  | "missed"
  /** Not enough billing days since the merge to judge. */
  | "pending";

export const VERDICT_LABELS: Record<ReceiptVerdict, string> = {
  "on-target": "On target",
  under: "Underestimated",
  over: "Overestimated",
  flagged: "Flagged, not priced",
  "wrong-direction": "Wrong direction",
  "no-effect": "No change seen",
  missed: "Missed",
  pending: "Waiting for bill",
};

/** A bill change attributed to the change (its rank-1 suspect). */
export interface MeasuredChange {
  anomalyId?: string;
  service: Service;
  tagValue?: string;
  onsetDate: IsoDate;
  /** Measured monthly impact (daily delta × 30). Negative is a saving. */
  monthlyUsd: number;
  persistent: boolean;
  /** Attribution confidence, 0..1. */
  confidence: number;
}

export interface ReceiptLine {
  detector: DetectorId;
  title: string;
  file: string;
  line?: number;
  services: Service[];
  /** Predicted monthly change; undefined when the PR check gave no dollar amount. */
  predictedUsd?: number;
  summary: string;
}

export interface CostReceipt {
  commitSha: string;
  prNumber: number | null;
  repo: string;
  title: string;
  author: string;
  mergedAt: string;
  url?: string;
  verdict: ReceiptVerdict;
  /** Sum of the priced predictions for the services the bill moved on (or all, when it didn't move). */
  predictedMonthlyUsd?: number;
  measuredMonthlyUsd: number;
  /** measured ÷ predicted, when both are known and nonzero. */
  ratio?: number;
  lines: ReceiptLine[];
  measured: MeasuredChange[];
  /** Billing days observed after the merge. */
  daysObserved: number;
  /** One sentence for lists and comments. */
  summary: string;
}

export interface ReceiptOptions {
  /** Billing days after merge before a prediction with no matching bill change counts as "no effect". */
  settleDays: number;
  /** Predictions smaller than this (absolute $/month) aren't held to account when the bill shows nothing. */
  minPredictedUsd: number;
  /** Findings below this confidence weren't shown by the PR check, so they aren't predictions. */
  minConfidence: number;
  /** Attributions below this confidence don't count as measured. */
  minAttributionConfidence: number;
  /** Ratio band counted as on target. */
  onTarget: [number, number];
}

export const DEFAULT_RECEIPT_OPTIONS: ReceiptOptions = {
  settleDays: 7,
  minPredictedUsd: 100,
  minConfidence: 0.6,
  minAttributionConfidence: 0.4,
  onTarget: [0.67, 1.5],
};

export interface ReceiptInput {
  deploy: Pick<Deploy, "commitSha" | "prNumber" | "repo" | "title" | "author" | "mergedAt" | "url">;
  /** Every priced finding in the change's diff (from priceDeploy, as of the day before merge). */
  priced: PricedFinding[];
  /** Bill changes whose rank-1 suspect is this change. */
  measured: MeasuredChange[];
  /** Latest billing day available. */
  dataEnd: IsoDate;
}

const money = (n: number) => `${n < 0 ? "−" : "+"}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/** Builds the receipt for one merged change, or null when there's nothing to account for. */
export function buildReceipt(input: ReceiptInput, options: Partial<ReceiptOptions> = {}): CostReceipt | null {
  const opts = { ...DEFAULT_RECEIPT_OPTIONS, ...options };
  const { deploy } = input;
  const daysObserved = Math.max(0, daysBetween(deploy.mergedAt.slice(0, 10), input.dataEnd));

  const measured = input.measured.filter((m) => m.persistent && m.confidence >= opts.minAttributionConfidence);
  const predictions = input.priced.filter((p) => p.finding.direction !== "unknown" && p.finding.confidence >= opts.minConfidence);
  const movedServices = new Set(measured.map((m) => m.service));
  // When the bill moved, hold the PR check to account for the services that moved.
  const relevant = movedServices.size ? predictions.filter((p) => p.finding.services.some((s) => movedServices.has(s))) : predictions;

  const lines: ReceiptLine[] = relevant.map((p) => ({
    detector: p.finding.detector,
    title: p.finding.title,
    file: p.finding.file,
    line: p.finding.line,
    services: p.finding.services,
    predictedUsd: p.estimate.monthlyUsd,
    summary: p.estimate.summary,
  }));
  const priced = lines.filter((l) => l.predictedUsd !== undefined);
  const predictedMonthlyUsd = priced.length ? priced.reduce((s, l) => s + l.predictedUsd!, 0) : undefined;
  const measuredMonthlyUsd = measured.reduce((s, m) => s + m.monthlyUsd, 0);
  const predictedSign = predictedMonthlyUsd !== undefined ? Math.sign(predictedMonthlyUsd) : directionSign(relevant);

  let verdict: ReceiptVerdict;
  let ratio: number | undefined;
  if (measured.length === 0) {
    if (lines.length === 0) return null;
    // Only priced predictions big enough to show in the bill are held to account.
    if (predictedMonthlyUsd === undefined || Math.abs(predictedMonthlyUsd) < opts.minPredictedUsd) return null;
    verdict = daysObserved < opts.settleDays ? "pending" : "no-effect";
  } else if (lines.length === 0) {
    verdict = "missed";
  } else if (predictedSign !== 0 && Math.sign(measuredMonthlyUsd) !== predictedSign) {
    verdict = "wrong-direction";
  } else if (predictedMonthlyUsd === undefined || predictedMonthlyUsd === 0) {
    verdict = "flagged";
  } else {
    ratio = measuredMonthlyUsd / predictedMonthlyUsd;
    verdict = ratio < opts.onTarget[0] ? "over" : ratio > opts.onTarget[1] ? "under" : "on-target";
  }

  const pred = predictedMonthlyUsd !== undefined ? `${money(predictedMonthlyUsd)}/mo` : "a cost change without an amount";
  const meas = `${money(measuredMonthlyUsd)}/mo`;
  const summary: Record<ReceiptVerdict, string> = {
    "on-target": `Predicted ${pred}, the bill measured ${meas} (${ratio?.toFixed(2)}×).`,
    under: `Predicted ${pred}, the bill measured ${meas}: ${ratio?.toFixed(1)}× more than estimated.`,
    over: `Predicted ${pred}, the bill measured ${meas}: ${ratio !== undefined && ratio > 0 ? `${(1 / ratio).toFixed(1)}× less` : "less"} than estimated.`,
    flagged: `Flagged before merge without an amount; the bill measured ${meas}.`,
    "wrong-direction": `Predicted ${pred}, but the bill moved the other way: ${meas}.`,
    "no-effect": `Predicted ${pred}; ${daysObserved} days after merge the bill shows no detectable change.`,
    missed: `The PR check predicted nothing here; the bill measured ${meas}.`,
    pending: `Predicted ${pred}; ${daysObserved} of ${opts.settleDays} billing days in so far.`,
  };

  return {
    commitSha: deploy.commitSha,
    prNumber: deploy.prNumber,
    repo: deploy.repo,
    title: deploy.title,
    author: deploy.author,
    mergedAt: deploy.mergedAt,
    url: deploy.url,
    verdict,
    predictedMonthlyUsd,
    measuredMonthlyUsd,
    ratio,
    lines,
    measured,
    daysObserved,
    summary: summary[verdict],
  };
}

function directionSign(p: PricedFinding[]): number {
  const s = p.reduce((n, x) => n + (x.finding.direction === "increase" ? 1 : x.finding.direction === "decrease" ? -1 : 0), 0);
  return Math.sign(s);
}

/** A learned correction for one detector's estimates on your bill. */
export interface DetectorCalibration {
  detector: DetectorId;
  /** Multiply the detector's estimate by this. Shrunk toward 1 when there are few receipts. */
  factor: number;
  /** Median measured ÷ predicted across receipts, before shrinking. */
  medianRatio: number;
  samples: number;
  /** Commit SHAs of the receipts it was learned from. */
  from: string[];
}

export type CalibrationTable = Partial<Record<DetectorId, DetectorCalibration>>;

const CLAMP: [number, number] = [0.25, 4];

/**
 * Learns one correction factor per detector from receipts that have a ratio.
 * Uses the median ratio in log space, shrunk toward 1 by n/(n+1), so a single
 * receipt moves estimates only halfway and outliers can't dominate.
 */
export function learnCalibration(receipts: CostReceipt[]): CalibrationTable {
  const byDetector = new Map<DetectorId, { ratios: number[]; from: string[] }>();
  for (const r of receipts) {
    if (r.ratio === undefined || r.ratio <= 0) continue;
    if (r.verdict !== "on-target" && r.verdict !== "under" && r.verdict !== "over") continue;
    const detectors = new Set(r.lines.filter((l) => l.predictedUsd !== undefined).map((l) => l.detector));
    for (const d of detectors) {
      const g = byDetector.get(d) ?? { ratios: [], from: [] };
      g.ratios.push(r.ratio);
      g.from.push(r.commitSha);
      byDetector.set(d, g);
    }
  }
  const table: CalibrationTable = {};
  for (const [detector, g] of byDetector) {
    const logs = g.ratios.map(Math.log).sort((a, b) => a - b);
    const mid = logs.length / 2;
    const medianLog = logs.length % 2 ? logs[Math.floor(mid)]! : (logs[mid - 1]! + logs[mid]!) / 2;
    const n = logs.length;
    const factor = Math.min(CLAMP[1], Math.max(CLAMP[0], Math.exp((medianLog * n) / (n + 1))));
    table[detector] = { detector, factor, medianRatio: Math.exp(medianLog), samples: n, from: g.from };
  }
  return table;
}

/** An estimate adjusted by what past receipts showed for its detector. */
export interface CalibratedAmount {
  monthlyUsd: number;
  factor: number;
  samples: number;
  /** One sentence, e.g. "Estimates from this check ran 1.3× low on your bill across 2 merged PRs." */
  note: string;
}

/** Applies the learned factor to a monthly estimate. Undefined when there's nothing to apply (no history, or within 5%). */
export function calibrate(detector: DetectorId, monthlyUsd: number | undefined, table: CalibrationTable | undefined): CalibratedAmount | undefined {
  const c = table?.[detector];
  if (!c || monthlyUsd === undefined || Math.abs(c.factor - 1) < 0.05) return undefined;
  const dir = c.medianRatio >= 1 ? `${c.medianRatio.toFixed(1)}× low` : `${(1 / c.medianRatio).toFixed(1)}× high`;
  return {
    monthlyUsd: monthlyUsd * c.factor,
    factor: c.factor,
    samples: c.samples,
    note: `Estimates from this check ran ${dir} on your bill across ${c.samples} merged PR${c.samples === 1 ? "" : "s"}, so this one is adjusted ×${c.factor.toFixed(2)}.`,
  };
}

/** Headline accuracy over a set of receipts. */
export function receiptStats(receipts: CostReceipt[]) {
  const judged = receipts.filter((r) => r.verdict !== "pending");
  const count = (v: ReceiptVerdict) => judged.filter((r) => r.verdict === v).length;
  const ratios = judged.map((r) => r.ratio).filter((x): x is number => x !== undefined && x > 0);
  const caught = count("on-target") + count("under") + count("over") + count("flagged");
  return {
    total: receipts.length,
    judged: judged.length,
    onTarget: count("on-target"),
    caught,
    missed: count("missed"),
    noEffect: count("no-effect"),
    /** Share of measured, attributed bill changes the PR check flagged before merge. */
    catchRate: caught + count("missed") + count("wrong-direction") > 0 ? caught / (caught + count("missed") + count("wrong-direction")) : undefined,
    /** Median absolute error of priced predictions, as a fraction (0.2 = 20% off). */
    medianError: ratios.length ? median(ratios.map((r) => Math.abs(r - 1))) : undefined,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 ? s[Math.floor(m)]! : (s[m - 1]! + s[m]!) / 2;
}
