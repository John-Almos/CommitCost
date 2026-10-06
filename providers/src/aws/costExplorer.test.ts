import type { GetCostAndUsageCommand, GetCostAndUsageCommandOutput } from "@aws-sdk/client-cost-explorer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCache } from "../cache/fileCache.js";
import { AwsCostExplorerProvider, type CostExplorerLike } from "./costExplorer.js";

function group(service: string, tag: string | undefined, amount: string) {
  return { Keys: tag === undefined ? [service] : [service, tag], Metrics: { UnblendedCost: { Amount: amount, Unit: "USD" } } };
}

/** Fake client that serves canned pages and records every request. */
function fakeClient(pages: Partial<GetCostAndUsageCommandOutput>[]): CostExplorerLike & { inputs: GetCostAndUsageCommand["input"][] } {
  const inputs: GetCostAndUsageCommand["input"][] = [];
  return {
    inputs,
    async send(command) {
      inputs.push(command.input);
      const i = command.input.NextPageToken ? Number(command.input.NextPageToken) : 0;
      return { $metadata: {}, ...pages[i]! };
    },
  };
}

const PAGES: Partial<GetCostAndUsageCommandOutput>[] = [
  {
    ResultsByTime: [
      {
        TimePeriod: { Start: "2026-09-01", End: "2026-09-02" },
        Groups: [
          group("Amazon Elastic Compute Cloud - Compute", "app$api", "100.004"),
          group("EC2 - Other", "app$api", "20"),
          group("Amazon Relational Database Service", "app$", "50.5"),
          group("AWS Key Management Service", "app$api", "1"),
          group("Amazon Route 53", "app$api", "2"),
        ],
      },
    ],
    NextPageToken: "1",
  },
  {
    ResultsByTime: [
      {
        TimePeriod: { Start: "2026-09-02", End: "2026-09-03" },
        Groups: [group("AWS Lambda", "app$worker", "7.25")],
      },
    ],
  },
];

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("AwsCostExplorerProvider", () => {
  it("requests daily costs grouped by service and tag, with an exclusive end date", async () => {
    const client = fakeClient(PAGES);
    await new AwsCostExplorerProvider({ client, tagKey: "app" }).getDailyCosts({ start: "2026-09-01", end: "2026-09-02" });
    expect(client.inputs[0]).toMatchObject({
      TimePeriod: { Start: "2026-09-01", End: "2026-09-03" },
      Granularity: "DAILY",
      Metrics: ["UnblendedCost"],
      GroupBy: [
        { Type: "DIMENSION", Key: "SERVICE" },
        { Type: "TAG", Key: "app" },
      ],
    });
  });

  it("follows pagination, maps service names, and sums services that share a name", async () => {
    const client = fakeClient(PAGES);
    const records = await new AwsCostExplorerProvider({ client, tagKey: "app", accountId: "111122223333" }).getDailyCosts({
      start: "2026-09-01",
      end: "2026-09-02",
    });
    expect(client.inputs).toHaveLength(2);
    expect(client.inputs[1]!.NextPageToken).toBe("1");
    expect(records).toEqual([
      { date: "2026-09-01", provider: "aws", accountId: "111122223333", service: "EC2", tagKey: "app", tagValue: "api", amountUsd: 120, source: "aws-cost-explorer" },
      { date: "2026-09-01", provider: "aws", accountId: "111122223333", service: "Other", tagKey: "app", tagValue: "api", amountUsd: 3, source: "aws-cost-explorer" },
      { date: "2026-09-01", provider: "aws", accountId: "111122223333", service: "RDS", tagKey: "app", tagValue: "", amountUsd: 50.5, source: "aws-cost-explorer" },
      { date: "2026-09-02", provider: "aws", accountId: "111122223333", service: "Lambda", tagKey: "app", tagValue: "worker", amountUsd: 7.25, source: "aws-cost-explorer" },
    ]);
  });

  it("groups by service only when no tag key is configured", async () => {
    const client = fakeClient([{ ResultsByTime: [{ TimePeriod: { Start: "2026-09-01", End: "2026-09-02" }, Groups: [group("AWS Lambda", undefined, "3")] }] }]);
    const records = await new AwsCostExplorerProvider({ client }).getDailyCosts({ start: "2026-09-01", end: "2026-09-01" });
    expect(client.inputs[0]!.GroupBy).toEqual([{ Type: "DIMENSION", Key: "SERVICE" }]);
    expect(records[0]).toMatchObject({ service: "Lambda", tagKey: "", tagValue: "", amountUsd: 3 });
  });

  it("caches settled ranges forever and recent ranges briefly", async () => {
    tmp = mkdtempSync(join(tmpdir(), "cc-cache-"));
    let now = Date.parse("2026-10-06T12:00:00Z");
    const cache = new FileCache(tmp, () => now);
    const client = fakeClient(PAGES);
    const provider = new AwsCostExplorerProvider({ client, tagKey: "app", cache, today: () => "2026-10-06" });

    const settled = { start: "2026-09-01", end: "2026-09-02" };
    await provider.getDailyCosts(settled);
    await provider.getDailyCosts(settled);
    expect(provider.requestCount).toBe(2); // two pages, fetched once

    const recent = { start: "2026-10-01", end: "2026-10-05" };
    await provider.getDailyCosts(recent);
    await provider.getDailyCosts(recent);
    expect(provider.requestCount).toBe(4);

    now += 7 * 60 * 60 * 1000;
    await provider.getDailyCosts(recent);
    expect(provider.requestCount).toBe(6); // recent entry expired
    await provider.getDailyCosts(settled);
    expect(provider.requestCount).toBe(6); // settled entry still cached
  });

  it("fetches usage by usage type per service, with quantity and cost", async () => {
    const inputs: GetCostAndUsageCommand["input"][] = [];
    const client: CostExplorerLike = {
      async send(command) {
        inputs.push(command.input);
        const services = command.input.Filter?.Dimensions?.Values ?? [];
        const groups = services.includes("AWS Lambda")
          ? [{ Keys: ["USE1-Lambda-GB-Second", "app$worker"], Metrics: { UsageQuantity: { Amount: "1000000", Unit: "Lambda-GB-Second" }, UnblendedCost: { Amount: "16.67", Unit: "USD" } } }]
          : services.includes("AWS Data Transfer")
            ? [{ Keys: ["USE1-USW2-AWS-Out-Bytes", "app$"], Metrics: { UsageQuantity: { Amount: "500", Unit: "GB" }, UnblendedCost: { Amount: "10", Unit: "USD" } } }]
            : [];
        return { $metadata: {}, ResultsByTime: [{ TimePeriod: { Start: "2026-09-01", End: "2026-09-02" }, Groups: groups }] };
      },
    };
    const usage = await new AwsCostExplorerProvider({ client, tagKey: "app" }).getUsage({ start: "2026-09-01", end: "2026-09-01" });
    expect(inputs[0]).toMatchObject({ Metrics: ["UsageQuantity", "UnblendedCost"], GroupBy: [{ Type: "DIMENSION", Key: "USAGE_TYPE" }, { Type: "TAG", Key: "app" }] });
    expect(inputs.every((i) => i.Filter?.Dimensions?.Key === "SERVICE")).toBe(true);
    expect(usage).toEqual([
      expect.objectContaining({ service: "DataTransfer", usageType: "USE1-USW2-AWS-Out-Bytes", tagValue: "", unit: "GB", quantity: 500, costUsd: 10 }),
      expect.objectContaining({ service: "Lambda", usageType: "USE1-Lambda-GB-Second", tagValue: "worker", unit: "Lambda-GB-Second", quantity: 1_000_000, costUsd: 16.67 }),
    ]);
  });
});
