import type { Deploy, IsoDate, PriceBook, UsageRecord } from "@commitcost/core";
import { addDays } from "@commitcost/core";
import { analyzeFile } from "../diff/detectors.js";
import type { DiffFinding } from "../diff/types.js";
import { costContext, type CostAssumptions, type CostContext } from "./context.js";
import { estimateCost } from "./estimate.js";
import { buildUsageProfile } from "./profile.js";
import type { CostEstimate } from "./types.js";

export interface PricedFinding {
  finding: DiffFinding;
  estimate: CostEstimate;
}

/** Every cost-relevant finding in a set of file diffs, increases and decreases, each priced. */
export function priceFiles(files: { path: string; patch?: string | null }[], ctx: CostContext): PricedFinding[] {
  return files.flatMap((f) => {
    const patch = f.patch ?? undefined;
    return analyzeFile({ path: f.path, patch }).map((finding) => ({ finding, estimate: estimateCost(finding, ctx, { patch }) }));
  });
}

/**
 * Prices a merged change the way the PR check would have just before it
 * merged: usage profile from the two weeks up to the day before the merge,
 * so the change's own effect isn't in its inputs.
 */
export function priceDeploy(
  deploy: Pick<Deploy, "mergedAt" | "files">,
  usage: UsageRecord[],
  prices?: PriceBook,
  assumptions?: Partial<CostAssumptions>,
): { ctx: CostContext; priced: PricedFinding[] } {
  const end: IsoDate = addDays(deploy.mergedAt.slice(0, 10), -1);
  const ctx0 = costContext({ prices, assumptions });
  const profile = buildUsageProfile(usage, ctx0.prices, { end });
  const ctx = costContext({ prices: ctx0.prices, usage: profile, assumptions });
  return { ctx, priced: priceFiles(deploy.files, ctx) };
}

/** Sum of the monthly estimates that have one. */
export function totalMonthly(priced: PricedFinding[]): number | undefined {
  const known = priced.filter((p) => p.estimate.monthlyUsd !== undefined);
  return known.length ? known.reduce((s, p) => s + p.estimate.monthlyUsd!, 0) : undefined;
}
