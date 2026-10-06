import type { CostAnomaly, CostRecord, IsoDate, Service } from "@commitcost/core";
import { isWeekend } from "@commitcost/core";
import { median, robustSd } from "./stats.js";

export interface AnomalyOptions {
  /** Days of history the baseline is drawn from. */
  baselineDays: number;
  /** Robust z-score needed to flag a day. */
  threshold: number;
  /** Ignore changes smaller than this many dollars per day... */
  minDeltaUsd: number;
  /** ...or smaller than this fraction of the baseline. */
  minRelativeDelta: number;
  /** Floor on the spread, as a fraction of baseline, so very flat series don't flag on pennies. */
  minSpreadFraction: number;
  /** Days after a run used to decide whether the change persisted. */
  persistenceDays: number;
  /** Same-direction runs separated by at most this many days are merged. */
  mergeGapDays: number;
  /** A tag gets credited with the anomaly if it holds this share of the delta. */
  tagDominance: number;
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyOptions = {
  baselineDays: 14,
  threshold: 4,
  minDeltaUsd: 10,
  minRelativeDelta: 0.1,
  minSpreadFraction: 0.03,
  persistenceDays: 7,
  tagDominance: 0.6,
  mergeGapDays: 3,
};

export interface DayEvaluation {
  date: IsoDate;
  observedUsd: number;
  baselineUsd: number;
  spreadUsd: number;
  score: number;
  flagged: boolean;
}

/**
 * The expected cost for day i: the median of the previous `baselineDays`
 * days of the same kind (weekdays against weekdays, weekends against
 * weekends). That handles weekly seasonality without a model, and the median
 * ignores a single earlier blip.
 */
function baselineFor(dates: IsoDate[], values: number[], i: number, opts: AnomalyOptions): { baseline: number; spread: number } | null {
  const weekend = isWeekend(dates[i]!);
  const peers: number[] = [];
  for (let j = Math.max(0, i - opts.baselineDays); j < i; j++) {
    if (isWeekend(dates[j]!) === weekend) peers.push(values[j]!);
  }
  if (peers.length < 3) return null;
  const baseline = median(peers);
  const spread = Math.max(robustSd(peers), Math.abs(baseline) * opts.minSpreadFraction, 0.01);
  return { baseline, spread };
}

/** Scores every day of one daily series. Days without enough history are skipped. */
export function evaluateSeries(dates: IsoDate[], values: number[], options: Partial<AnomalyOptions> = {}): DayEvaluation[] {
  const opts = { ...DEFAULT_ANOMALY_OPTIONS, ...options };
  const out: DayEvaluation[] = [];
  for (let i = 0; i < dates.length; i++) {
    const b = baselineFor(dates, values, i, opts);
    if (!b) continue;
    const delta = values[i]! - b.baseline;
    const score = delta / b.spread;
    const flagged =
      Math.abs(score) >= opts.threshold &&
      Math.abs(delta) >= opts.minDeltaUsd &&
      Math.abs(delta) >= Math.abs(b.baseline) * opts.minRelativeDelta;
    out.push({ date: dates[i]!, observedUsd: values[i]!, baselineUsd: b.baseline, spreadUsd: b.spread, score, flagged });
  }
  return out;
}

interface Series {
  dates: IsoDate[];
  values: number[];
}

/** Totals per service per day, and the same split by tag value. */
function buildSeries(records: CostRecord[]) {
  const dates = [...new Set(records.map((r) => r.date))].sort();
  const index = new Map(dates.map((d, i) => [d, i]));
  const byService = new Map<Service, number[]>();
  const byTag = new Map<string, number[]>();
  for (const r of records) {
    const i = index.get(r.date)!;
    if (!byService.has(r.service)) byService.set(r.service, new Array(dates.length).fill(0));
    byService.get(r.service)![i]! += r.amountUsd;
    const key = `${r.service}|${r.tagValue}`;
    if (!byTag.has(key)) byTag.set(key, new Array(dates.length).fill(0));
    byTag.get(key)![i]! += r.amountUsd;
  }
  return { dates, byService, byTag };
}

/**
 * Finds anomalies per service. Consecutive flagged days in the same direction
 * become one anomaly whose onset is the first flagged day. A step change gets
 * flagged until the rolling baseline catches up (about a week); a blip gets
 * flagged for a day or two.
 */
export function detectAnomalies(records: CostRecord[], options: Partial<AnomalyOptions> = {}): CostAnomaly[] {
  const opts = { ...DEFAULT_ANOMALY_OPTIONS, ...options };
  const { dates, byService, byTag } = buildSeries(records);
  const anomalies: CostAnomaly[] = [];

  for (const [service, values] of byService) {
    const evals = evaluateSeries(dates, values, opts);
    const offset = dates.length - evals.length;

    for (const [k, end] of findRuns(evals, opts.mergeGapDays)) {
      const first = evals[k]!;
      const run = evals.slice(k, end + 1).filter((e) => e.flagged);
      const onsetIndex = k + offset;
      // Measure the change against the pre-onset baseline. Later days in the
      // run have baselines already contaminated by the new level.
      const baselineUsd = first.baselineUsd;
      const observedUsd = run.reduce((s, e) => s + e.observedUsd, 0) / run.length;
      const deltaUsd = observedUsd - baselineUsd;

      const after = values.slice(end + offset + 1, end + offset + 1 + opts.persistenceDays);
      const persistent = after.length === 0 ? run.length > 1 : Math.abs(median(after) - baselineUsd) >= Math.abs(deltaUsd) * 0.5;

      anomalies.push({
        service,
        tagValue: dominantTag(byTag, service, onsetIndex, run.length, deltaUsd, dates, opts),
        onsetDate: first.date,
        durationDays: end - k + 1,
        baselineUsd: round(baselineUsd),
        observedUsd: round(observedUsd),
        deltaUsd: round(deltaUsd),
        direction: deltaUsd >= 0 ? "increase" : "decrease",
        score: round(Math.max(...run.map((e) => Math.abs(e.score)))),
        persistent,
        estimatedMonthlyImpactUsd: round(persistent ? deltaUsd * 30 : run.reduce((s, e) => s + (e.observedUsd - e.baselineUsd), 0)),
      });
    }
  }
  return anomalies.sort((a, b) => a.onsetDate.localeCompare(b.onsetDate) || a.service.localeCompare(b.service));
}

/**
 * Groups flagged days into [start, end] index ranges. Same-direction runs a
 * few days apart are one change: weekend days have their own, slower-moving
 * baseline, so a step change can re-flag on the first weekend after the
 * weekday baseline has caught up.
 */
function findRuns(evals: DayEvaluation[], mergeGapDays: number): [number, number][] {
  const runs: [number, number][] = [];
  for (let k = 0; k < evals.length; k++) {
    if (!evals[k]!.flagged) continue;
    const sign = Math.sign(evals[k]!.score);
    let end = k;
    while (end + 1 < evals.length && evals[end + 1]!.flagged && Math.sign(evals[end + 1]!.score) === sign) end++;
    const prev = runs.at(-1);
    if (prev && Math.sign(evals[prev[0]]!.score) === sign && k - prev[1] - 1 <= mergeGapDays) prev[1] = end;
    else runs.push([k, end]);
    k = end;
  }
  return runs;
}

function dominantTag(
  byTag: Map<string, number[]>,
  service: Service,
  onsetIndex: number,
  length: number,
  totalDelta: number,
  dates: IsoDate[],
  opts: AnomalyOptions,
): string | undefined {
  let best: { tag: string; delta: number } | undefined;
  for (const [key, values] of byTag) {
    const [svc, tag] = key.split("|") as [string, string];
    if (svc !== service) continue;
    const b = baselineFor(dates, values, onsetIndex, opts);
    if (!b) continue;
    const observed = values.slice(onsetIndex, onsetIndex + length);
    const delta = observed.reduce((s, v) => s + v, 0) / observed.length - b.baseline;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { tag, delta };
  }
  if (!best || totalDelta === 0) return undefined;
  return best.delta / totalDelta >= opts.tagDominance ? best.tag : undefined;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
