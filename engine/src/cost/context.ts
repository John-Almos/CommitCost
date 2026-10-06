import type { PriceBook, Service } from "@commitcost/core";
import { SnapshotPriceBook } from "./aws/snapshot.js";
import type { UsageProfile } from "./profile.js";

/**
 * Values the diff and the bill usually can't tell us. Every one of them shows
 * up as a labeled input when an estimate uses it, and every one can be set in
 * configuration (the Action's `assumptions` input, or a cost profile file).
 */
export interface CostAssumptions {
  /** Instances behind a resource when the diff doesn't give a count. */
  instanceCount: number;
  /** Instance type for a count change when the diff names none and the bill has no match. */
  instanceType: string;
  /** RDS engine when the diff doesn't say. */
  rdsEngine: string;
  /** Items a new per-item query loops over, when the diff has no LIMIT. */
  loopItems: number;
  /** Share of reads a removed cache used to serve. */
  cacheHitRate: number;
  /** Average duration of a scheduled job's run. */
  scheduledRunSeconds: number;
  /** Lambda memory for a scheduled job when the diff doesn't set it. */
  lambdaMemoryMb: number;
  /** Size of one log line. */
  logLineBytes: number;
  /** Average size of one replicated DynamoDB write. */
  dynamoItemKb: number;
  /** Requests a month that reach the changed code path. Unknown by default: estimates fall back to per-unit prices. */
  requestsPerMonth?: number;
  /** Invocations a month of the changed Lambda function. */
  lambdaInvocationsPerMonth?: number;
  /** Average duration of the changed Lambda function. */
  lambdaDurationSeconds?: number;
  /** GB a month written to a bucket that gets replicated. */
  replicatedGbPerMonth?: number;
  /** GB a month through a new NAT gateway. */
  natGbPerMonth?: number;
}

export const DEFAULT_ASSUMPTIONS: CostAssumptions = {
  instanceCount: 1,
  instanceType: "m5.large",
  rdsEngine: "postgres",
  loopItems: 50,
  cacheHitRate: 0.8,
  scheduledRunSeconds: 10,
  lambdaMemoryMb: 1024,
  logLineBytes: 1024,
  dynamoItemKb: 1,
};

export interface CostContext {
  prices: PriceBook;
  /** Region for resources whose diff doesn't name one. */
  region: string;
  /** Measured usage from the bill, when an account is connected (or in mock mode). */
  usage?: UsageProfile;
  assumptions: CostAssumptions;
  /** Assumption keys set in configuration rather than left at the default. */
  configured: ReadonlySet<keyof CostAssumptions>;
  /** Current monthly spend per service, when known but per-usage-type data isn't (Action `service-spend` input). */
  serviceSpend?: Partial<Record<Service, number>>;
}

export interface CostContextInput {
  prices?: PriceBook;
  region?: string;
  usage?: UsageProfile;
  assumptions?: Partial<CostAssumptions>;
  serviceSpend?: Partial<Record<Service, number>>;
}

let defaultPrices: PriceBook | undefined;

/** Fills in the bundled price snapshot, the bill's main region (or us-east-1) and default assumptions. */
export function costContext(input: CostContextInput = {}): CostContext {
  const set = Object.entries(input.assumptions ?? {}).filter(([, v]) => v !== undefined);
  return {
    prices: input.prices ?? (defaultPrices ??= new SnapshotPriceBook()),
    region: input.region ?? input.usage?.primaryRegion ?? "us-east-1",
    usage: input.usage,
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...Object.fromEntries(set) },
    configured: new Set(set.map(([k]) => k as keyof CostAssumptions)),
    serviceSpend: input.serviceSpend,
  };
}

/** What each assumption means and when the model uses it, for docs and the dashboard. */
export const ASSUMPTION_DOCS: Record<keyof CostAssumptions, { label: string; unit?: string; usedFor: string }> = {
  instanceCount: { label: "Instances behind a resource", unit: "instances", usedFor: "Instance size changes when the diff has no count and the bill has no matching usage" },
  instanceType: { label: "Instance type", usedFor: "Instance count changes when neither the diff nor the bill names a type" },
  rdsEngine: { label: "RDS engine", usedFor: "RDS prices when the diff doesn't set `engine`" },
  loopItems: { label: "Items per loop", unit: "items", usedFor: "N+1 queries when the outer query has no LIMIT" },
  cacheHitRate: { label: "Cache hit rate", unit: "share of reads", usedFor: "Removed caches: reads grow by hit ÷ (1 − hit)" },
  scheduledRunSeconds: { label: "Scheduled run duration", unit: "s", usedFor: "Scheduled Lambda jobs that run more often" },
  lambdaMemoryMb: { label: "Lambda memory", unit: "MB", usedFor: "Scheduled jobs and provisioned concurrency when the diff doesn't set memory" },
  logLineBytes: { label: "Log line size", unit: "bytes", usedFor: "Logging added inside loops" },
  dynamoItemKb: { label: "DynamoDB item size", unit: "KB", usedFor: "Transfer for global table replicas" },
  requestsPerMonth: { label: "Requests to the changed path", unit: "requests/month", usedFor: "Turns per-request estimates (N+1, removed cache) into monthly figures" },
  lambdaInvocationsPerMonth: { label: "Lambda invocations", unit: "invocations/month", usedFor: "Exact monthly figure for a Lambda memory change" },
  lambdaDurationSeconds: { label: "Lambda duration", unit: "s", usedFor: "With invocations, for Lambda memory changes" },
  replicatedGbPerMonth: { label: "GB replicated", unit: "GB/month", usedFor: "S3 replication, instead of the bill's data-in volume" },
  natGbPerMonth: { label: "GB through a new NAT gateway", unit: "GB/month", usedFor: "NAT data processing on top of the hourly charge" },
};
