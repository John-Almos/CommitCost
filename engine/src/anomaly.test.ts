import type { CostRecord } from "@commitcost/core";
import { addDays, isWeekend } from "@commitcost/core";
import { describe, expect, it } from "vitest";
import { detectAnomalies, evaluateSeries } from "./anomaly.js";
import { median, robustSd } from "./stats.js";

const START = "2026-06-01"; // a Monday

/** Builds a deterministic daily series with optional weekend dip and pseudo-noise. */
function series(days: number, fn: (i: number, date: string) => number, service: CostRecord["service"] = "RDS", tagValue = "api"): CostRecord[] {
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(START, i);
    return { date, provider: "aws", accountId: "1", service, tagKey: "app", tagValue, amountUsd: fn(i, date), source: "mock" } as CostRecord;
  });
}

/** Small deterministic wobble (±2%) so the spread isn't zero. */
const wobble = (i: number) => 1 + 0.02 * Math.sin(i * 2.3);

describe("stats", () => {
  it("computes median and MAD-based spread", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(robustSd([1, 1, 1, 1])).toBe(0);
    expect(robustSd([1, 2, 3, 4, 100])).toBeCloseTo(1.4826, 3);
  });
});

describe("detectAnomalies", () => {
  it("finds nothing in a flat, noisy series", () => {
    expect(detectAnomalies(series(60, (i) => 100 * wobble(i)))).toEqual([]);
  });

  it("does not flag the weekly weekend dip", () => {
    const records = series(60, (i, d) => 100 * wobble(i) * (isWeekend(d) ? 0.6 : 1));
    expect(detectAnomalies(records)).toEqual([]);
  });

  it("finds a step change once, with onset, delta, persistence and monthly impact", () => {
    const records = series(60, (i) => (i >= 30 ? 150 : 100) * wobble(i));
    const [a, ...rest] = detectAnomalies(records);
    expect(rest).toEqual([]);
    expect(a).toMatchObject({ service: "RDS", tagValue: "api", onsetDate: addDays(START, 30), direction: "increase", persistent: true });
    expect(a!.deltaUsd).toBeGreaterThan(45);
    expect(a!.deltaUsd).toBeLessThan(55);
    expect(a!.estimatedMonthlyImpactUsd).toBeCloseTo(a!.deltaUsd * 30, 0);
  });

  it("finds a decrease", () => {
    const [a] = detectAnomalies(series(60, (i) => (i >= 30 ? 50 : 100) * wobble(i)));
    expect(a).toMatchObject({ direction: "decrease", persistent: true });
    expect(a!.deltaUsd).toBeLessThan(-45);
  });

  it("treats a one-day blip as non-persistent with a one-off impact", () => {
    const [a] = detectAnomalies(series(60, (i) => 100 * wobble(i) + (i === 40 ? 80 : 0)));
    expect(a).toMatchObject({ onsetDate: addDays(START, 40), durationDays: 1, persistent: false });
    expect(a!.estimatedMonthlyImpactUsd).toBeCloseTo(a!.deltaUsd, 0);
  });

  it("ignores changes below the dollar and percentage floors", () => {
    expect(detectAnomalies(series(60, (i) => (i >= 30 ? 108 : 100)))).toEqual([]); // 8%, $8
    expect(detectAnomalies(series(60, (i) => (i >= 30 ? 3 : 1), "Lambda"))).toEqual([]); // 200% but $2
  });

  it("does not split a step change at the first weekend", () => {
    const records = series(70, (i, d) => (i >= 30 ? 300 : 100) * wobble(i) * (isWeekend(d) ? 0.7 : 1));
    expect(detectAnomalies(records)).toHaveLength(1);
  });

  it("credits the tag that holds most of the change", () => {
    const records = [
      ...series(60, (i) => (i >= 30 ? 160 : 100) * wobble(i), "EC2", "worker"),
      ...series(60, (i) => 200 * wobble(i + 7), "EC2", "api"),
    ];
    expect(detectAnomalies(records)[0]!.tagValue).toBe("worker");
  });

  it("skips days without enough history", () => {
    expect(evaluateSeries(["2026-06-01", "2026-06-02"], [1, 100])).toEqual([]);
  });
});
