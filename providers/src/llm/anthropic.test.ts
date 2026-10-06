import type { Attribution, Deploy } from "@commitcost/core";
import { describe, expect, it } from "vitest";
import { AnthropicExplainer } from "./anthropic.js";

const deploy: Deploy = {
  repo: "acme/app",
  commitSha: "abc1234def",
  prNumber: 7,
  mergedAt: "2026-09-08T12:00:00Z",
  author: "dev",
  title: "Show items",
  files: [{ path: "orders.ts", additions: 2, deletions: 0, patch: "@@ -1 +1,2 @@\n+for (const o of os) {\n+  await db.query(q, [o.id]);" }],
};

const attribution: Attribution = {
  anomaly: {
    service: "RDS",
    onsetDate: "2026-09-10",
    durationDays: 7,
    baselineUsd: 100,
    observedUsd: 180,
    deltaUsd: 80,
    direction: "increase",
    score: 9,
    persistent: true,
    estimatedMonthlyImpactUsd: 2400,
  },
  repo: "acme/app",
  commitSha: "abc1234def",
  prNumber: 7,
  title: "Show items",
  evidence: [{ file: "orders.ts", line: 2, detail: "Database query inside a loop (N+1)" }],
  rank: 1,
  confidence: 0.82,
  scores: { timing: 0.7, relevance: 0.86, total: 0.81 },
  explanation: "heuristic",
  explanationSource: "heuristic",
  estimatedMonthlyImpactUsd: 2400,
};

function fakeClient(response: { stop_reason: string; content: { type: string; text?: string }[] }) {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    client: { beta: { messages: { create: async (req: Record<string, unknown>) => (requests.push(req), response) } } } as never,
  };
}

describe("AnthropicExplainer", () => {
  it("sends the diff and cost context and returns the text", async () => {
    const { client, requests } = fakeClient({ stop_reason: "end_turn", content: [{ type: "text", text: " The loop runs a query per order. " }] });
    const text = await new AnthropicExplainer({ client }).explain({ attribution, deploy });
    expect(text).toBe("The loop runs a query per order.");
    const req = requests[0]!;
    expect(req).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    const prompt = (req.messages as { content: string }[])[0]!.content;
    expect(prompt).toContain("RDS cost rose $80/day");
    expect(prompt).toContain('PR #7 "Show items"');
    expect(prompt).toContain("await db.query(q, [o.id]);");
    expect(prompt).toContain("orders.ts:2: Database query inside a loop");
  });

  it("throws on a refusal so the caller keeps the heuristic text", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [] });
    await expect(new AnthropicExplainer({ client }).explain({ attribution, deploy })).rejects.toThrow(/declined/);
  });
});
