import type { CostAnomaly, Deploy } from "@commitcost/core";
import { describe, expect, it } from "vitest";
import { confidenceFor, relevance, scoreCandidates, toAttributions } from "./attribution.js";

const anomaly: CostAnomaly = {
  service: "RDS",
  tagValue: "api",
  onsetDate: "2026-09-10",
  durationDays: 7,
  baselineUsd: 100,
  observedUsd: 180,
  deltaUsd: 80,
  direction: "increase",
  score: 12,
  persistent: true,
  estimatedMonthlyImpactUsd: 2400,
};

function deploy(sha: string, mergedAt: string, files: Deploy["files"], title = sha): Deploy {
  return { repo: "acme/app", commitSha: sha, prNumber: Number(sha.replace(/\D/g, "")) || null, mergedAt, author: "dev", title, files };
}

const N_PLUS_ONE = [
  {
    path: "services/api/src/routes/orders.ts",
    additions: 4,
    deletions: 0,
    patch: `@@ -1 +1,4 @@\n+for (const o of orders) {\n+  await db.query("SELECT * FROM items WHERE order_id = $1", [o.id]);\n+}`,
  },
];
const CSS = [{ path: "web/src/app.css", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a{}\n+b{}" }];
const MIGRATION = [{ path: "services/api/migrations/001_idx.sql", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+CREATE INDEX x ON y (z);" }];

describe("relevance", () => {
  it("is high for a matching pattern, weak for a path hint, zero otherwise", () => {
    expect(relevance(deploy("a1", "2026-09-08T12:00:00Z", N_PLUS_ONE), anomaly).score).toBeGreaterThan(0.8);
    const hinted = relevance(deploy("a2", "2026-09-08T12:00:00Z", MIGRATION), anomaly);
    expect(hinted.score).toBeGreaterThan(0.25);
    expect(hinted.score).toBeLessThan(0.45);
    expect(hinted.hintedFiles).toEqual(["services/api/migrations/001_idx.sql"]);
    expect(relevance(deploy("a3", "2026-09-08T12:00:00Z", CSS), anomaly).score).toBe(0);
  });

  it("discounts a finding that points the opposite way", () => {
    const shrink = [{ path: "db.tf", additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-  instance_class = "db.r6g.2xlarge"\n+  instance_class = "db.r6g.xlarge"` }];
    const up = relevance(deploy("a4", "2026-09-09T00:00:00Z", shrink), { ...anomaly, direction: "decrease", deltaUsd: -80 }).score;
    const down = relevance(deploy("a4", "2026-09-09T00:00:00Z", shrink), anomaly).score;
    expect(up).toBeGreaterThan(down * 2);
  });

  it("ignores findings for other services", () => {
    const lambda = [{ path: "serverless.yml", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-    memorySize: 512\n+    memorySize: 3008" }];
    expect(relevance(deploy("a5", "2026-09-09T00:00:00Z", lambda), anomaly).score).toBe(0);
  });
});

describe("scoreCandidates", () => {
  const deploys = [
    deploy("pr1", "2026-09-05T12:00:00Z", N_PLUS_ONE), // outside the 3-day window
    deploy("pr2", "2026-09-07T12:00:00Z", N_PLUS_ONE, "the cause"), // 3 days before
    deploy("pr3", "2026-09-10T08:00:00Z", CSS, "same-day css"),
    deploy("pr4", "2026-09-09T12:00:00Z", MIGRATION, "index"),
    deploy("pr5", "2026-09-11T12:00:00Z", N_PLUS_ONE), // after onset
  ];

  it("considers only deploys from 3 days before onset through the onset day", () => {
    expect(scoreCandidates(anomaly, deploys).map((c) => c.deploy.commitSha).sort()).toEqual(["pr2", "pr3", "pr4"]);
  });

  it("ranks the relevant change above closer but unrelated ones", () => {
    const ranked = scoreCandidates(anomaly, deploys);
    expect(ranked.map((c) => c.deploy.title)).toEqual(["the cause", "index", "same-day css"]);
    expect(ranked[0]!.lagDays).toBe(3);
    expect(ranked[2]!.timing).toBe(1);
  });

  it("prefers the closer deploy when relevance ties", () => {
    const ranked = scoreCandidates(anomaly, [deploy("pr6", "2026-09-07T00:00:00Z", N_PLUS_ONE), deploy("pr7", "2026-09-09T00:00:00Z", N_PLUS_ONE)]);
    expect(ranked[0]!.deploy.commitSha).toBe("pr7");
  });
});

describe("confidence and output", () => {
  it("is high with a clear winner, lower when a runner-up is close, capped without relevance", () => {
    const clear = scoreCandidates(anomaly, [deploy("b1", "2026-09-09T00:00:00Z", N_PLUS_ONE), deploy("b2", "2026-09-09T00:00:00Z", CSS)]);
    const close = scoreCandidates(anomaly, [deploy("b1", "2026-09-09T00:00:00Z", N_PLUS_ONE), deploy("b3", "2026-09-09T00:00:00Z", N_PLUS_ONE)]);
    const none = scoreCandidates(anomaly, [deploy("b2", "2026-09-09T00:00:00Z", CSS)]);
    expect(confidenceFor(clear, 0, anomaly)).toBeGreaterThan(0.75);
    expect(confidenceFor(close, 0, anomaly)).toBeLessThan(confidenceFor(clear, 0, anomaly));
    expect(confidenceFor(none, 0, anomaly)).toBeLessThanOrEqual(0.25);
    expect(confidenceFor(clear, 0, { ...anomaly, persistent: false })).toBeLessThan(confidenceFor(clear, 0, anomaly));
  });

  it("produces ranked attributions with evidence, explanation and monthly impact", () => {
    const ranked = scoreCandidates(anomaly, [deploy("pr42", "2026-09-08T15:00:00Z", N_PLUS_ONE, "Show items"), deploy("pr43", "2026-09-09T00:00:00Z", CSS)]);
    const [top, second] = toAttributions(anomaly, ranked);
    expect(top).toMatchObject({ rank: 1, commitSha: "pr42", prNumber: 42, explanationSource: "heuristic", estimatedMonthlyImpactUsd: 2400 });
    expect(top!.evidence[0]).toMatchObject({ file: "services/api/src/routes/orders.ts", line: 2 });
    expect(top!.explanation).toContain('PR #42 "Show items"');
    expect(top!.explanation).toContain("merged 2 days before");
    expect(top!.explanation).toContain("services/api/src/routes/orders.ts:2");
    expect(top!.explanation).toContain("$2,400/month");
    expect(second!.rank).toBe(2);
    expect(second!.confidence).toBeLessThan(top!.confidence);
  });
});
