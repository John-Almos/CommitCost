import { generateMockDataset } from "@commitcost/providers";
import { describe, expect, it } from "vitest";
import { analyze } from "./analyze.js";
import { buildReceipts, codeMapFrom, fixFor, learnedProfile, type TopAttribution } from "./insights.js";
import { receiptStats } from "./receipts.js";

describe("history features on mock data", async () => {
  const data = generateMockDataset({ endDate: "2026-10-05" });
  const reports = await analyze(data.costs, data.deploys);
  const attributions: TopAttribution[] = reports
    .filter((r) => r.suspects[0])
    .map((r, i) => ({
      anomalyId: `a${i}`,
      service: r.anomaly.service,
      tagValue: r.anomaly.tagValue ?? "",
      onsetDate: r.anomaly.onsetDate,
      direction: r.anomaly.direction,
      persistent: r.anomaly.persistent,
      monthlyUsd: r.anomaly.estimatedMonthlyImpactUsd,
      commitSha: r.suspects[0]!.commitSha,
      confidence: r.suspects[0]!.confidence,
      evidence: r.suspects[0]!.evidence,
    }));
  const input = { deploys: data.deploys, attributions, usage: data.usage, dataEnd: data.end, codeowners: data.codeowners };

  it("issues a receipt for every injected change and the PR check flagged all of them", () => {
    const receipts = buildReceipts(input);
    for (const spike of data.spikes) expect(receipts.find((r) => r.commitSha === spike.commitSha), spike.key).toBeDefined();
    const stats = receiptStats(receipts);
    expect(stats.catchRate).toBe(1);
    expect(stats.medianError).toBeLessThan(0.35);
  });

  it("learns corrections and costly files for the cost profile", () => {
    const learned = learnedProfile(input);
    expect(Object.keys(learned.calibration).sort()).toEqual(["compute-size", "cross-region-transfer", "lambda-config", "query-in-loop", "removed-cache"]);
    expect(learned.history.map((h) => h.path)).toContain("services/api/src/routes/orders.ts");
    expect(learned.history.find((h) => h.path === "services/api/src/routes/orders.ts")!.owners).toEqual(["@acme/api-team"]);
  });

  it("maps cost onto the files and owners behind it", () => {
    const map = codeMapFrom(data.deploys, attributions, data.codeowners);
    expect(map.files[0]!.path).toBe("infra/terraform/worker.tf");
    expect(map.owners.map((o) => o.owner)).toContain("@acme/storage");
    expect(map.unownedUsd).toBe(0);
  });

  it("builds a fix patch for each injected increase, net of later savings", () => {
    for (const spike of data.spikes.filter((s) => s.direction === "increase")) {
      const deploy = data.deploys.find((d) => d.commitSha === spike.commitSha)!;
      const fix = fixFor(deploy, attributions, data.deploys);
      expect(fix, spike.key).not.toBeNull();
      expect(fix!.savingsUsd).toBeGreaterThan(0);
    }
    const lambda = data.spikes.find((s) => s.key === "reports-lambda-memory")!;
    const fix = fixFor(data.deploys.find((d) => d.commitSha === lambda.commitSha)!, attributions, data.deploys)!;
    expect(fix.laterSavingsUsd).toBeLessThan(0);
    expect(fix.remainingUsd).toBeLessThan(fix.savingsUsd / 2);
    expect(fix.fix.patch).toContain("+    memorySize: 512\n");
  });
});
