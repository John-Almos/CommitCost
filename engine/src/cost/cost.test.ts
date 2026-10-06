import { tieredCost, unitsForCost, type UsageRecord } from "@commitcost/core";
import { describe, expect, it } from "vitest";
import { generateMockDataset } from "../../../providers/src/mock/generate.js";
import { analyzeFile } from "../diff/detectors.js";
import { stripRegionPrefix } from "./aws/regions.js";
import { SnapshotPriceBook } from "./aws/snapshot.js";
import { priceKeyForUsage } from "./aws/usageTypes.js";
import { priceDeploy, totalMonthly } from "./change.js";
import { costContext } from "./context.js";
import { estimateCost } from "./estimate.js";
import { buildUsageProfile, effectiveRatio, findLines } from "./profile.js";

const prices = new SnapshotPriceBook();

const RESIZE = `@@ -12,10 +12,10 @@ module "worker_asg" {
   name             = "worker"
-  instance_type    = "m5.xlarge"
+  instance_type    = "m5.2xlarge"
   min_size         = 3
   max_size         = 6
   desired_capacity = 3`;

const finding = (path: string, patch: string) => analyzeFile({ path, patch })[0]!;

describe("price book", () => {
  it("has real on-demand list prices from the AWS price files", () => {
    expect(prices.price("us-east-1", "AmazonEC2", "BoxUsage:m5.xlarge")?.tiers[0]?.usdPerUnit).toBe(0.192);
    expect(prices.price("us-east-1", "AWSLambda", "Lambda-GB-Second")?.tiers[0]?.usdPerUnit).toBeCloseTo(0.0000166667, 10);
    expect(prices.price("us-east-1", "AWSDataTransfer", "USW2-AWS-Out-Bytes")?.tiers[0]?.usdPerUnit).toBe(0.02);
    expect(prices.price("us-east-1", "AmazonRDS", "Multi-AZUsage:db.r6g.xlarge@postgres")).toBeDefined();
    // Regions differ: eu-west-1 is pricier than us-east-1 for the same instance.
    expect(prices.price("eu-west-1", "AmazonEC2", "BoxUsage:m5.xlarge")!.tiers[0]!.usdPerUnit).toBeGreaterThan(0.192);
  });

  it("walks volume tiers both ways", () => {
    const egress = prices.price("us-east-1", "AWSDataTransfer", "DataTransfer-Out-Bytes")!;
    expect(tieredCost(egress, 10240)).toBeCloseTo(10240 * 0.09, 6);
    expect(tieredCost(egress, 20000)).toBeCloseTo(10240 * 0.09 + (20000 - 10240) * 0.085, 6);
    expect(unitsForCost(egress, tieredCost(egress, 77777))).toBeCloseTo(77777, 4);
  });
});

describe("usage types", () => {
  it("maps billed usage types onto the price book", () => {
    expect(stripRegionPrefix("USW2-BoxUsage:m5.large")).toEqual({ region: "us-west-2", usageType: "BoxUsage:m5.large" });
    expect(priceKeyForUsage("Multi-AZUsage:db.r6g.2xl", "RDS")).toEqual({ region: "us-east-1", offer: "AmazonRDS", key: "Multi-AZUsage:db.r6g.2xlarge@postgres" });
    expect(priceKeyForUsage("USE1-USW2-AWS-Out-Bytes", "DataTransfer")).toEqual({ region: "us-east-1", offer: "AWSDataTransfer", key: "USW2-AWS-Out-Bytes" });
  });
});

describe("estimateCost", () => {
  it("shows the formula and labels every input with its source", () => {
    const e = estimateCost(finding("infra/terraform/worker.tf", RESIZE), costContext());
    expect(e.monthlyUsd).toBeCloseTo(3 * (0.384 - 0.192) * 730, 6);
    expect(e.basis).toBe("list-price");
    expect(e.formula).toBe("3 × ($0.384 − $0.192)/h × 730 h");
    expect(e.inputs.map((i) => [i.label, i.source])).toEqual([
      ["instance type before → after", "diff"],
      ["m5.xlarge on-demand price", "price-list"],
      ["m5.2xlarge on-demand price", "price-list"],
      ["instances (desired_capacity)", "diff"],
    ]);
  });

  it("uses the region the diff names", () => {
    const patch = `@@ -1,4 +1,4 @@\n provider = aws.eu_west_1\n-  instance_type = "m5.xlarge"\n+  instance_type = "m5.2xlarge"\n   desired_capacity = 2`;
    const e = estimateCost(finding("infra/ec2.tf", patch), costContext(), { patch });
    expect(e.region).toBe("eu-west-1");
    expect(e.inputs.find((i) => i.label === "m5.xlarge on-demand price")!.value).toBe(prices.price("eu-west-1", "AmazonEC2", "BoxUsage:m5.xlarge")!.tiers[0]!.usdPerUnit);
  });

  it("calibrates instance counts and discounts with the bill", () => {
    const usage: UsageRecord[] = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      provider: "aws",
      accountId: "1",
      service: "EC2",
      usageType: "BoxUsage:m5.xlarge",
      tagKey: "app",
      tagValue: "worker",
      unit: "Hrs",
      quantity: 20 * 24,
      costUsd: 20 * 24 * 0.192 * 0.7,
      source: "aws-cost-explorer",
    }));
    const profile = buildUsageProfile(usage, prices)!;
    expect(effectiveRatio(findLines(profile, { tag: "worker" }))).toBeCloseTo(0.7, 6);
    const e = estimateCost(finding("infra/terraform/worker.tf", RESIZE), costContext({ usage: profile }));
    expect(e.basis).toBe("usage-calibrated");
    expect(e.monthlyUsd).toBeCloseTo(20 * 0.192 * 730 * 0.7, 3);
    expect(e.calibration?.diffOnlyMonthlyUsd).toBeCloseTo(420.48, 2);
    expect(e.calibration?.note).toContain("about 20 m5.xlarge");
  });

  it("marks configured assumptions as config, defaults as default", () => {
    const patch = `@@ -1,3 +1,3 @@\n   getProduct(id) {\n-    const cached = await this.cache.get(id);\n-    if (cached) return cached;\n     const res = await ddb.send(new GetItemCommand({ TableName: T, Key: k }));`;
    const f = finding("services/api/catalog.ts", patch);
    const byDefault = estimateCost(f, costContext());
    expect(byDefault.inputs.find((i) => i.ref === "assumptions.cacheHitRate")?.source).toBe("default");
    expect(byDefault.basis).toBe("per-unit");
    const configured = estimateCost(f, costContext({ assumptions: { cacheHitRate: 0.9, requestsPerMonth: 10_000_000 } }));
    expect(configured.inputs.find((i) => i.ref === "assumptions.cacheHitRate")?.source).toBe("config");
    expect(configured.monthlyUsd).toBeCloseTo(10_000_000 * 0.9 * 0.000000125, 6);
  });
});

describe("against the mock bill", () => {
  const ds = generateMockDataset({ endDate: "2026-10-05" });

  it("lands within 2x of every injected change, priced only from data before the merge", () => {
    for (const spike of ds.spikes) {
      const deploy = ds.deploys.find((d) => d.commitSha === spike.commitSha)!;
      const services = new Set(spike.effects.map((e) => e.service));
      const priced = priceDeploy(deploy, ds.usage).priced.filter((p) => p.finding.services.some((s) => services.has(s)));
      const ratio = totalMonthly(priced)! / spike.estimatedMonthlyImpactUsd;
      expect(ratio, spike.key).toBeGreaterThan(0.5);
      expect(ratio, spike.key).toBeLessThan(2);
    }
  });

  it("derives usage that adds back up to the cost records", () => {
    const day = ds.costs[0]!.date;
    const cost = ds.costs.filter((c) => c.date === day).reduce((s, c) => s + c.amountUsd, 0);
    const usage = ds.usage.filter((u) => u.date === day).reduce((s, u) => s + u.costUsd, 0);
    expect(usage).toBeCloseTo(cost, 0);
  });
});
