import { generateMockDataset, type MockDataset } from "@commitcost/providers";
import { describe, expect, it } from "vitest";
import { analyze, type AnomalyReport } from "./analyze.js";
import type { Explainer } from "./explain.js";

const DAY = 86_400_000;

/** The report for an injected effect: same service, onset within 2 days (ramps can delay detection). */
function reportFor(reports: AnomalyReport[], service: string, onset: string) {
  return reports.find((r) => r.anomaly.service === service && Math.abs(Date.parse(r.anomaly.onsetDate) - Date.parse(onset)) <= 2 * DAY);
}

async function check(data: MockDataset) {
  const reports = await analyze(data.costs, data.deploys);
  for (const spike of data.spikes) {
    for (const effect of spike.effects) {
      const report = reportFor(reports, effect.service, spike.onsetDate);
      expect(report, `${spike.key} on ${effect.service} detected`).toBeDefined();
      expect(report!.anomaly.direction).toBe(spike.direction);
      expect(report!.suspects[0]?.commitSha, `${spike.key} on ${effect.service} ranked #1`).toBe(spike.commitSha);
      expect(report!.suspects[0]!.confidence).toBeGreaterThanOrEqual(0.6);
    }
  }
  return reports;
}

describe("attribution on mock data", () => {
  const data = generateMockDataset({ endDate: "2026-10-05" });

  it("ranks the injected commit #1 for every injected cost change", async () => {
    await check(data);
  });

  it("reports the no-cause blip with low confidence and a one-off impact", async () => {
    const reports = await analyze(data.costs, data.deploys);
    const blip = data.unexplained[0]!;
    const report = reports.find((r) => r.anomaly.service === blip.service && r.anomaly.onsetDate === blip.date)!;
    expect(report.anomaly.persistent).toBe(false);
    expect(report.suspects[0]!.confidence).toBeLessThan(0.3);
    expect(report.suspects[0]!.explanation).toMatch(/usage-driven/);
  });

  it("raises no other anomalies", async () => {
    const reports = await analyze(data.costs, data.deploys);
    const expected = data.spikes.reduce((n, s) => n + s.effects.length, 0) + data.unexplained.length;
    expect(reports).toHaveLength(expected);
  });

  it("estimates monthly impact within 25% of the injected delta", async () => {
    const reports = await analyze(data.costs, data.deploys);
    for (const spike of data.spikes) {
      for (const effect of spike.effects) {
        const r = reportFor(reports, effect.service, spike.onsetDate)!;
        // Ramps and weekend dips pull the measured delta below the full effect.
        expect(Math.abs(r.anomaly.estimatedMonthlyImpactUsd)).toBeGreaterThan(Math.abs(effect.dailyDeltaUsd) * 30 * 0.75);
        expect(Math.abs(r.anomaly.estimatedMonthlyImpactUsd)).toBeLessThan(Math.abs(effect.dailyDeltaUsd) * 30 * 1.25);
      }
    }
  });

  it.each([1, 2, 3, 7, 13, 99])("holds across noise seeds (seed %i)", async (seed) => {
    await check(generateMockDataset({ endDate: "2026-10-05", seed }));
  });
});

describe("LLM explainer hook", () => {
  const data = generateMockDataset({ endDate: "2026-10-05" });

  it("replaces the top suspect's explanation for confident attributions only", async () => {
    const seen: string[] = [];
    const explainer: Explainer = {
      name: "fake",
      async explain({ attribution, deploy }) {
        seen.push(deploy.commitSha);
        return `LLM says ${attribution.title}`;
      },
    };
    const reports = await analyze(data.costs, data.deploys, { explainer });
    const confident = reports.filter((r) => (r.suspects[0]?.confidence ?? 0) >= 0.3);
    expect(seen).toHaveLength(confident.length);
    for (const r of confident) expect(r.suspects[0]).toMatchObject({ explanationSource: "llm", explanation: `LLM says ${r.suspects[0]!.title}` });
    for (const r of reports.filter((x) => !confident.includes(x))) expect(r.suspects[0]!.explanationSource).toBe("heuristic");
  });

  it("keeps the heuristic explanation when the explainer fails", async () => {
    const errors: unknown[] = [];
    const reports = await analyze(data.costs, data.deploys, {
      explainer: { name: "broken", explain: () => Promise.reject(new Error("rate limited")) },
      onExplainerError: (e) => errors.push(e),
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(reports.every((r) => r.suspects.every((s) => s.explanationSource === "heuristic"))).toBe(true);
  });
});
