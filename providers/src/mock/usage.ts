import type { CostRecord, KnownService, UnitPrice, UsageRecord } from "@commitcost/core";
import { unitsForCost } from "@commitcost/core";
import { DAYS_PER_MONTH, SnapshotPriceBook, priceKeyForUsage } from "@commitcost/engine";
import { EFFECTIVE_RATE, FREE_USAGE, USAGE_MIX } from "./profiles.js";

/** How one cost record's amount was built: baseline plus each effect, before noise. */
export interface CostParts {
  base: number;
  extra: { usageType: string; usd: number; replaces?: string }[];
  /** Noise applied to the record: final amount ÷ (base + extras). */
  scale?: number;
}

const prices = new SnapshotPriceBook();

function priceFor(usageType: string, service: KnownService): UnitPrice {
  const key = priceKeyForUsage(usageType, service);
  const p = key && prices.price(key.region, key.offer, key.key);
  if (!p) throw new Error(`Mock usage type ${usageType} (${service}) has no price in the bundled snapshot`);
  return p;
}

const effectiveRate = (usageType: string) => Object.entries(EFFECTIVE_RATE).find(([prefix]) => usageType.startsWith(prefix))?.[1] ?? 1;

/**
 * Splits each mock cost record across usage types and derives quantities
 * from list prices (volume tiers included, on the account's monthly total)
 * and the mock account's discounts. Cost per usage type sums back to the
 * cost record exactly.
 */
export function buildUsage(costs: CostRecord[], parts: CostParts[]): UsageRecord[] {
  // Cost per (date, service, tag, usage type).
  const rows: Omit<UsageRecord, "quantity" | "unit">[] = [];
  costs.forEach((r, i) => {
    const part = parts[i]!;
    const scale = part.scale ?? 1;
    const service = r.service as KnownService;
    const replaced = new Map(part.extra.filter((e) => e.replaces).map((e) => [e.replaces!, e.usageType]));
    const byType = new Map<string, number>();
    const add = (t: string, usd: number) => byType.set(t, (byType.get(t) ?? 0) + usd);
    for (const [usageType, share] of USAGE_MIX[service][r.tagValue] ?? []) add(replaced.get(usageType) ?? usageType, part.base * share * scale);
    for (const e of part.extra) add(e.usageType, e.usd * scale);
    for (const [usageType, costUsd] of byType) {
      rows.push({ date: r.date, provider: r.provider, accountId: r.accountId, service, usageType, tagKey: r.tagKey, tagValue: r.tagValue, costUsd: Math.round(costUsd * 1e4) / 1e4, source: "mock" });
    }
  });

  // Quantities: tiers apply to the account's monthly volume of a usage type, so
  // invert on the day's total (as a monthly rate) and share it out by cost.
  const totals = new Map<string, number>();
  const keyOf = (r: { date: string; service: string; usageType: string }) => `${r.date}|${r.service}|${r.usageType}`;
  for (const r of rows) totals.set(keyOf(r), (totals.get(keyOf(r)) ?? 0) + r.costUsd);
  const usage: UsageRecord[] = rows.map((r) => {
    const p = priceFor(r.usageType, r.service as KnownService);
    const total = totals.get(keyOf(r))!;
    const monthlyListUsd = (total / effectiveRate(r.usageType)) * DAYS_PER_MONTH;
    const dayUnits = unitsForCost(p, monthlyListUsd) / DAYS_PER_MONTH;
    return { ...r, unit: p.unit, quantity: total > 0 ? (dayUnits * r.costUsd) / total : 0 };
  });

  const days = [...new Set(costs.map((c) => c.date))];
  const sample = costs[0];
  for (const f of FREE_USAGE) {
    for (const date of days) {
      usage.push({ date, provider: "aws", accountId: sample?.accountId ?? "", service: f.service, usageType: f.usageType, tagKey: sample?.tagKey ?? "", tagValue: f.tagValue, unit: f.unit, quantity: f.dailyQuantity, costUsd: 0, source: "mock" });
    }
  }
  return usage;
}
