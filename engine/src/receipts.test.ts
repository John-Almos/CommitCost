import { describe, expect, it } from "vitest";
import type { PricedFinding } from "./cost/change.js";
import type { DetectorId } from "./diff/types.js";
import { buildReceipt, calibrate, learnCalibration, receiptStats, type MeasuredChange, type ReceiptInput } from "./receipts.js";

const finding = (detector: DetectorId, monthlyUsd: number | undefined, over: Partial<PricedFinding["finding"]> = {}): PricedFinding => ({
  finding: {
    detector,
    file: "f.ts",
    line: 1,
    side: "new",
    services: ["RDS"],
    costArea: "",
    direction: monthlyUsd !== undefined && monthlyUsd < 0 ? "decrease" : "increase",
    confidence: 0.85,
    title: detector,
    why: "",
    suggestion: "",
    snippet: "",
    ...over,
  },
  estimate: { basis: "usage-calibrated", monthlyUsd, formula: "", inputs: [], assumptions: [], region: "us-east-1", priceSource: "", summary: "" },
});

const measured = (monthlyUsd: number, over: Partial<MeasuredChange> = {}): MeasuredChange => ({
  service: "RDS",
  onsetDate: "2026-08-03",
  monthlyUsd,
  persistent: true,
  confidence: 0.8,
  ...over,
});

const input = (priced: PricedFinding[], m: MeasuredChange[], dataEnd = "2026-09-30", sha = "a".repeat(40)): ReceiptInput => ({
  deploy: { commitSha: sha, prNumber: 1, repo: "o/r", title: "t", author: "x", mergedAt: "2026-08-01T12:00:00Z" },
  priced,
  measured: m,
  dataEnd,
});

describe("buildReceipt", () => {
  it("is on target within the band", () => {
    const r = buildReceipt(input([finding("query-in-loop", 3000)], [measured(2850)]))!;
    expect(r.verdict).toBe("on-target");
    expect(r.ratio).toBeCloseTo(0.95);
  });

  it("calls under- and overestimates", () => {
    expect(buildReceipt(input([finding("query-in-loop", 1000)], [measured(2850)]))!.verdict).toBe("under");
    expect(buildReceipt(input([finding("query-in-loop", 9000)], [measured(2850)]))!.verdict).toBe("over");
  });

  it("only holds predictions to account for the services the bill moved on", () => {
    const r = buildReceipt(input([finding("query-in-loop", 3000), finding("hot-path-logging", 500, { services: ["Other"] })], [measured(2850)]))!;
    expect(r.lines.map((l) => l.detector)).toEqual(["query-in-loop"]);
    expect(r.predictedMonthlyUsd).toBe(3000);
  });

  it("reports a miss when the bill moved and nothing was predicted", () => {
    expect(buildReceipt(input([], [measured(1500)]))!.verdict).toBe("missed");
  });

  it("waits for the bill to settle before calling no effect", () => {
    expect(buildReceipt(input([finding("compute-size", 2000)], [], "2026-08-04"))!.verdict).toBe("pending");
    expect(buildReceipt(input([finding("compute-size", 2000)], [], "2026-08-20"))!.verdict).toBe("no-effect");
    expect(buildReceipt(input([finding("compute-size", 20)], [], "2026-08-20"))).toBeNull();
  });

  it("ignores blips and low-confidence attributions", () => {
    expect(buildReceipt(input([], [measured(85, { persistent: false }), measured(900, { confidence: 0.1 })]))).toBeNull();
  });

  it("handles qualitative predictions and savings", () => {
    expect(buildReceipt(input([finding("removed-cache", undefined)], [measured(1500)]))!.verdict).toBe("flagged");
    const saving = buildReceipt(input([finding("lambda-config", -2500, { services: ["Lambda"] })], [measured(-2730, { service: "Lambda" })]))!;
    expect(saving.verdict).toBe("on-target");
    expect(buildReceipt(input([finding("lambda-config", -2500, { services: ["Lambda"] })], [measured(900, { service: "Lambda" })]))!.verdict).toBe("wrong-direction");
  });
});

describe("calibration", () => {
  const receipts = [
    buildReceipt(input([finding("query-in-loop", 1000)], [measured(2000)], undefined, "1".repeat(40)))!,
    buildReceipt(input([finding("query-in-loop", 1000)], [measured(1500)], undefined, "2".repeat(40)))!,
    buildReceipt(input([finding("compute-size", 1000, { services: ["EC2"] })], [measured(1000, { service: "EC2" })], undefined, "3".repeat(40)))!,
  ];
  const table = learnCalibration(receipts);

  it("learns a shrunk median ratio per detector", () => {
    const q = table["query-in-loop"]!;
    expect(q.samples).toBe(2);
    expect(q.medianRatio).toBeCloseTo(Math.sqrt(2 * 1.5));
    expect(q.factor).toBeCloseTo(Math.exp((Math.log(Math.sqrt(3)) * 2) / 3));
    expect(table["compute-size"]!.factor).toBe(1);
  });

  it("adjusts estimates and explains why, but not when there's no correction", () => {
    const c = calibrate("query-in-loop", 1000, table)!;
    expect(c.monthlyUsd).toBeCloseTo(1000 * table["query-in-loop"]!.factor);
    expect(c.note).toMatch(/ran 1\.7× low on your bill across 2 merged PRs/);
    expect(calibrate("compute-size", 1000, table)).toBeUndefined();
    expect(calibrate("removed-cache", 1000, table)).toBeUndefined();
  });

  it("summarizes accuracy", () => {
    const s = receiptStats([...receipts, buildReceipt(input([], [measured(900)]))!]);
    expect(s.catchRate).toBeCloseTo(3 / 4);
    expect(s.onTarget).toBe(2);
  });
});
