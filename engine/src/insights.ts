import type { AnomalyDirection, Deploy, IsoDate, PriceBook, Service, UsageRecord } from "@commitcost/core";
import type { CostAssumptions } from "./cost/context.js";
import { priceDeploy } from "./cost/change.js";
import { analyzeFile } from "./diff/detectors.js";
import { buildCodeMap, costHistory, type AttributedChange, type CodeMap, type FileCostHistory } from "./codeMap.js";
import { buildFixPatch, type FixPatch } from "./fixPatch.js";
import { DEFAULT_RECEIPT_OPTIONS, buildReceipt, learnCalibration, type CalibrationTable, type CostReceipt, type ReceiptOptions } from "./receipts.js";

/**
 * Glue between stored analysis results and the three history features
 * (receipts, code cost map, fix patches), shared by the CLI and dashboard.
 */

/** A stored anomaly with its rank-1 suspect. */
export interface TopAttribution {
  anomalyId: string;
  service: Service;
  tagValue: string;
  onsetDate: IsoDate;
  direction: AnomalyDirection;
  persistent: boolean;
  /** Measured monthly impact (signed). */
  monthlyUsd: number;
  commitSha: string;
  confidence: number;
  evidence: { file: string; line?: number }[];
}

export interface HistoryInput {
  deploys: Deploy[];
  attributions: TopAttribution[];
  usage: UsageRecord[];
  prices?: PriceBook;
  assumptions?: Partial<CostAssumptions>;
  /** Latest billing day available. */
  dataEnd: IsoDate;
}

const confident = (a: TopAttribution, min = DEFAULT_RECEIPT_OPTIONS.minAttributionConfidence) => a.persistent && a.confidence >= min;

/** A receipt for every merged change the PR check predicted something for, or that the bill moved on. */
export function buildReceipts(input: HistoryInput, options: Partial<ReceiptOptions> = {}): CostReceipt[] {
  const opts = { ...DEFAULT_RECEIPT_OPTIONS, ...options };
  const bySha = new Map<string, TopAttribution[]>();
  for (const a of input.attributions) bySha.set(a.commitSha, [...(bySha.get(a.commitSha) ?? []), a]);

  const receipts: CostReceipt[] = [];
  for (const d of input.deploys) {
    const attributed = bySha.get(d.commitSha) ?? [];
    // Pricing builds a usage profile per change; skip changes with nothing to price and nothing measured.
    const predicts = d.files.some((f) => analyzeFile({ path: f.path, patch: f.patch }).some((x) => x.direction !== "unknown" && x.confidence >= opts.minConfidence));
    if (!predicts && !attributed.some((a) => confident(a, opts.minAttributionConfidence))) continue;
    const priced = predicts ? priceDeploy(d, input.usage, input.prices, input.assumptions).priced : [];
    const receipt = buildReceipt(
      {
        deploy: d,
        priced,
        measured: attributed.map((a) => ({ anomalyId: a.anomalyId, service: a.service, tagValue: a.tagValue, onsetDate: a.onsetDate, monthlyUsd: a.monthlyUsd, persistent: a.persistent, confidence: a.confidence })),
        dataEnd: input.dataEnd,
      },
      opts,
    );
    if (receipt) receipts.push(receipt);
  }
  return receipts.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
}

/** Merged changes with the persistent bill changes confidently attributed to them. */
export function attributedChanges(deploys: Deploy[], attributions: TopAttribution[], minConfidence = 0.4): AttributedChange[] {
  const out: AttributedChange[] = [];
  for (const d of deploys) {
    const mine = attributions.filter((a) => a.commitSha === d.commitSha && confident(a, minConfidence));
    if (!mine.length) continue;
    out.push({
      commitSha: d.commitSha,
      prNumber: d.prNumber,
      title: d.title,
      author: d.author,
      mergedAt: d.mergedAt,
      files: d.files,
      evidenceFiles: mine.flatMap((a) => a.evidence.map((e) => e.file)),
      services: [...new Set(mine.map((a) => a.service))],
      monthlyUsd: mine.reduce((s, a) => s + a.monthlyUsd, 0),
      anomalyIds: mine.map((a) => a.anomalyId),
    });
  }
  return out;
}

export function codeMapFrom(deploys: Deploy[], attributions: TopAttribution[], codeowners?: string): CodeMap {
  return buildCodeMap(attributedChanges(deploys, attributions), codeowners);
}

/** What `npm run profile` adds to the cost profile from your history. */
export function learnedProfile(input: HistoryInput & { codeowners?: string }): { calibration: CalibrationTable; history: FileCostHistory[] } {
  return {
    calibration: learnCalibration(buildReceipts(input)),
    history: costHistory(codeMapFrom(input.deploys, input.attributions, input.codeowners)),
  };
}

export interface CostFix {
  commitSha: string;
  prNumber: number | null;
  title: string;
  /** Measured monthly increase the change caused. */
  savingsUsd: number;
  /** Savings later changes to the same files already made on the same services (negative or 0). */
  laterSavingsUsd: number;
  /** What reverting would still save today: the increase net of those later savings, never below 0. */
  remainingUsd: number;
  services: Service[];
  fix: FixPatch;
  /** Later merged changes that touched the same files; the patch may need a manual merge. */
  laterChanges: { commitSha: string; prNumber: number | null; title: string; files: string[] }[];
  /** The detectors' own suggestions: usually a better fix than reverting. */
  suggestions: string[];
}

/** The partial revert for the persistent increases attributed to one change, or null when nothing can be tied to them. */
export function fixFor(deploy: Deploy, attributions: TopAttribution[], allDeploys: Deploy[] = []): CostFix | null {
  const mine = attributions.filter((a) => a.commitSha === deploy.commitSha && confident(a) && a.direction === "increase");
  if (!mine.length) return null;
  const services = [...new Set(mine.map((a) => a.service))];
  const fix = buildFixPatch(deploy.files, { services, evidence: mine.flatMap((a) => a.evidence) });
  if (!fix) return null;
  const paths = new Set(fix.files.map((f) => f.path));
  const later = allDeploys.filter((d) => d.mergedAt > deploy.mergedAt && d.files.some((f) => paths.has(f.path)));
  const laterChanges = later.map((d) => ({ commitSha: d.commitSha, prNumber: d.prNumber, title: d.title, files: d.files.filter((f) => paths.has(f.path)).map((f) => f.path) }));
  const laterShas = new Set(later.map((d) => d.commitSha));
  const laterSavingsUsd = attributions
    .filter((a) => laterShas.has(a.commitSha) && confident(a) && a.direction === "decrease" && services.includes(a.service))
    .reduce((s, a) => s + a.monthlyUsd, 0);
  const savingsUsd = mine.reduce((s, a) => s + a.monthlyUsd, 0);
  return {
    commitSha: deploy.commitSha,
    prNumber: deploy.prNumber,
    title: deploy.title,
    savingsUsd,
    laterSavingsUsd,
    remainingUsd: Math.max(0, savingsUsd + laterSavingsUsd),
    services,
    fix,
    laterChanges,
    suggestions: [...new Set(fix.findings.map((f) => f.suggestion).filter(Boolean))],
  };
}
