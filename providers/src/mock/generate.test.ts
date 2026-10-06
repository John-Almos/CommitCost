import { SERVICES, addDays, daysBetween, type Service } from "@commitcost/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateMockDataset, type MockDataset } from "./generate.js";
import { MockCostProvider, MockVcsProvider } from "./provider.js";
import { SERVICE_PROFILES } from "./profiles.js";

const END = "2026-10-05";
const data = generateMockDataset({ endDate: END });

/** Daily total for one service and tag value, keyed by date. */
function series(ds: MockDataset, service: Service, tagValue: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of ds.costs) {
    if (r.service === service && r.tagValue === tagValue) out.set(r.date, (out.get(r.date) ?? 0) + r.amountUsd);
  }
  return out;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function window(s: Map<string, number>, from: string, days: number): number[] {
  return Array.from({ length: days }, (_, i) => s.get(addDays(from, i))!);
}

describe("generateMockDataset", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("covers 90 days for every service and tag", () => {
    expect(data.start).toBe("2026-07-08");
    expect(data.end).toBe(END);
    const tagRows = SERVICES.reduce((n, s) => n + Object.keys(SERVICE_PROFILES[s].tagShares).length, 0);
    expect(data.costs).toHaveLength(90 * tagRows);
    for (const service of SERVICES) {
      const days = new Set(data.costs.filter((r) => r.service === service).map((r) => r.date));
      expect(days.size).toBe(90);
    }
    expect(data.costs.every((r) => r.amountUsd >= 0 && r.source === "mock")).toBe(true);
  });

  it("is deterministic for a seed and different across seeds", () => {
    expect(generateMockDataset({ endDate: END })).toEqual(data);
    const other = generateMockDataset({ endDate: END, seed: 7 });
    expect(other.costs.map((c) => c.amountUsd)).not.toEqual(data.costs.map((c) => c.amountUsd));
    expect(other.spikes.map((s) => s.title)).toEqual(data.spikes.map((s) => s.title));
  });

  it("works with no credentials in the environment", () => {
    for (const key of Object.keys(process.env)) {
      if (/^(AWS_|GITHUB_|GH_)/.test(key)) vi.stubEnv(key, undefined);
    }
    expect(generateMockDataset({ endDate: END }).costs.length).toBeGreaterThan(0);
  });

  it("has weekly seasonality on traffic-driven services", () => {
    const lambda = series(data, "Lambda", "api");
    const pre = [...lambda.entries()].filter(([d]) => d < data.spikes[0]!.onsetDate);
    const weekend = pre.filter(([d]) => [0, 6].includes(new Date(d).getUTCDay())).map(([, v]) => v);
    const weekday = pre.filter(([d]) => ![0, 6].includes(new Date(d).getUTCDay())).map(([, v]) => v);
    expect(mean(weekend) / mean(weekday)).toBeLessThan(0.8);
  });

  it("produces a realistic merge history", () => {
    expect(data.deploys.length).toBeGreaterThan(100);
    expect(new Set(data.deploys.map((d) => d.commitSha)).size).toBe(data.deploys.length);
    for (let i = 1; i < data.deploys.length; i++) {
      expect(data.deploys[i]!.mergedAt >= data.deploys[i - 1]!.mergedAt).toBe(true);
      expect(data.deploys[i]!.prNumber).toBe(data.deploys[i - 1]!.prNumber! + 1);
    }
    for (const d of data.deploys) {
      expect(d.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(d.files.length).toBeGreaterThan(0);
      expect(d.mergedAt.slice(0, 10) >= data.start && d.mergedAt.slice(0, 10) <= data.end).toBe(true);
    }
  });
});

describe("injected spikes", () => {
  it("includes at least 3 cost increases across different services", () => {
    const increases = data.spikes.filter((s) => s.direction === "increase");
    expect(increases.length).toBeGreaterThanOrEqual(3);
    expect(new Set(increases.flatMap((s) => s.effects.map((e) => e.service))).size).toBeGreaterThanOrEqual(3);
  });

  it.each(data.spikes.map((s) => [s.key, s] as const))("%s: causing commit is in history 0-3 days before onset", (_, spike) => {
    const deploy = data.deploys.find((d) => d.commitSha === spike.commitSha);
    expect(deploy).toBeDefined();
    expect(deploy!.prNumber).toBe(spike.prNumber);
    expect(deploy!.title).toBe(spike.title);
    expect(deploy!.files.some((f) => f.patch && f.patch.length > 0)).toBe(true);
    const lag = daysBetween(spike.mergedAt.slice(0, 10), spike.onsetDate);
    expect(lag).toBe(spike.lagDays);
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThanOrEqual(3);
  });

  it.each(data.spikes.map((s) => [s.key, s] as const))("%s: other deploys share the lookback window", (_, spike) => {
    // Ranking must use the diff, not just "the only commit nearby".
    const from = addDays(spike.onsetDate, -3);
    const nearby = data.deploys.filter(
      (d) => d.commitSha !== spike.commitSha && d.mergedAt.slice(0, 10) >= from && d.mergedAt.slice(0, 10) <= spike.onsetDate,
    );
    expect(nearby.length).toBeGreaterThanOrEqual(2);
  });

  it.each(data.spikes.flatMap((s) => s.effects.map((e) => [`${s.key} ${e.service}`, s, e] as const)))(
    "%s: cost step is visible and well above noise",
    (_, spike, effect) => {
      const s = series(data, effect.service, effect.tagValue);
      const before = window(s, addDays(spike.onsetDate, -14), 14);
      const settled = addDays(spike.onsetDate, effect.rampDays);
      const after = window(s, settled, 7);
      const step = mean(after) - mean(before);
      const sd = Math.sqrt(mean(before.map((v) => (v - mean(before)) ** 2)));

      // Traffic-driven deltas shrink at weekends, so allow some slack.
      expect(Math.sign(step)).toBe(Math.sign(effect.dailyDeltaUsd));
      expect(Math.abs(step)).toBeGreaterThan(Math.abs(effect.dailyDeltaUsd) * 0.7);
      expect(Math.abs(step)).toBeGreaterThan(sd * 4);
    },
  );

  it("cost is flat in the days before each onset", () => {
    for (const spike of data.spikes) {
      for (const effect of spike.effects) {
        const s = series(data, effect.service, effect.tagValue);
        const before = window(s, addDays(spike.onsetDate, -7), 7);
        const earlier = window(s, addDays(spike.onsetDate, -14), 7);
        expect(Math.abs(mean(before) - mean(earlier))).toBeLessThan(Math.abs(effect.dailyDeltaUsd) * 0.25);
      }
    }
  });

  it("includes a one-day blip with no causing commit", () => {
    expect(data.unexplained).toHaveLength(1);
    const blip = data.unexplained[0]!;
    const s = series(data, blip.service, blip.tagValue);
    expect(s.get(blip.date)! - s.get(addDays(blip.date, -7))!).toBeGreaterThan(blip.deltaUsd * 0.6);
    expect(data.spikes.some((sp) => sp.onsetDate === blip.date)).toBe(false);
  });

  it("estimates monthly impact as daily delta x 30", () => {
    for (const s of data.spikes) expect(s.estimatedMonthlyImpactUsd).toBe(s.dailyDeltaUsd * 30);
  });

  it("keeps spikes in the latest 90 days for longer windows", () => {
    const long = generateMockDataset({ endDate: END, days: 120 });
    expect(long.start).toBe(addDays(END, -119));
    expect(long.spikes.map((s) => s.onsetDate)).toEqual(data.spikes.map((s) => s.onsetDate));
    expect(() => generateMockDataset({ days: 30 })).toThrow(/at least/);
  });
});

describe("mock providers", () => {
  it("filter by inclusive date range", async () => {
    const range = { start: "2026-09-01", end: "2026-09-07" };
    const costs = await new MockCostProvider(data).getDailyCosts(range);
    expect(new Set(costs.map((c) => c.date))).toEqual(new Set(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"]));
    const deploys = await new MockVcsProvider(data).getDeploys(range);
    expect(deploys.length).toBeGreaterThan(0);
    expect(deploys.every((d) => d.mergedAt >= "2026-09-01" && d.mergedAt < "2026-09-08")).toBe(true);
  });

  it("generate their own dataset from options", async () => {
    const p = new MockCostProvider({ endDate: END });
    expect(await p.getDailyCosts({ start: data.start, end: data.end })).toEqual(data.costs);
  });
});
