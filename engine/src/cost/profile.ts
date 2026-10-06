import type { IsoDate, PriceBook, Service, UsageRecord } from "@commitcost/core";
import { addDays, tieredCost } from "@commitcost/core";
import { stripRegionPrefix } from "./aws/regions.js";
import { describeUsageType, priceKeyForUsage, type PriceKey } from "./aws/usageTypes.js";

/** AWS bills a month as 730 hours. Every monthly figure in the cost model uses it. */
export const HOURS_PER_MONTH = 730;
export const DAYS_PER_MONTH = HOURS_PER_MONTH / 24;

/** One usage type's monthly volume and cost, as measured from the bill. */
export interface UsageLine {
  /** As billed, e.g. "USW2-BoxUsage:m5.large". */
  rawUsageType: string;
  /** Without the region prefix, e.g. "BoxUsage:m5.large". */
  usageType: string;
  region: string;
  service: Service;
  tagValue: string;
  unit: string;
  description: string;
  monthlyQuantity: number;
  monthlyCostUsd: number;
  /** What you actually pay per unit: cost ÷ quantity. Includes Savings Plans, RIs and credits when the bill does. */
  effectiveRate?: number;
  /** List price per unit at this volume, from the price book. */
  listRate?: number;
  priceKey?: PriceKey;
}

/** Your measured usage over a recent window (default the last 14 days), scaled to a 730-hour month. */
export interface UsageProfile {
  window: { start: IsoDate; end: IsoDate; days: number };
  lines: UsageLine[];
  /** Region with the most spend: the default for estimates whose diff names none. */
  primaryRegion: string;
  tagValues: string[];
}

/** Two full weeks: recent enough to reflect the current run-rate, whole weeks so weekends don't skew it. */
export const DEFAULT_PROFILE_DAYS = 14;

export interface ProfileOptions {
  /** Last day of the window, inclusive. Defaults to the latest day in the records. */
  end?: IsoDate;
  days?: number;
  rdsEngine?: string;
}

/**
 * Turns usage records from the bill into monthly volumes and effective rates
 * per usage type and tag. Returns undefined when there is no usage in the window.
 */
export function buildUsageProfile(records: UsageRecord[], prices: PriceBook, options: ProfileOptions = {}): UsageProfile | undefined {
  if (records.length === 0) return undefined;
  const days = options.days ?? DEFAULT_PROFILE_DAYS;
  const end = options.end ?? records.reduce((m, r) => (r.date > m ? r.date : m), records[0]!.date);
  const start = addDays(end, -(days - 1));
  const inWindow = records.filter((r) => r.date >= start && r.date <= end);
  if (inWindow.length === 0) return undefined;
  const observedDays = new Set(inWindow.map((r) => r.date)).size;
  const scale = DAYS_PER_MONTH / observedDays;

  const groups = new Map<string, UsageLine>();
  for (const r of inWindow) {
    const k = `${r.service}|${r.usageType}|${r.tagValue}`;
    let line = groups.get(k);
    if (!line) {
      const { region = "us-east-1", usageType } = stripRegionPrefix(r.usageType);
      line = {
        rawUsageType: r.usageType,
        usageType,
        region,
        service: r.service,
        tagValue: r.tagValue,
        unit: r.unit,
        description: describeUsageType(r.usageType),
        monthlyQuantity: 0,
        monthlyCostUsd: 0,
        priceKey: priceKeyForUsage(r.usageType, r.service, options.rdsEngine),
      };
      groups.set(k, line);
    }
    line.monthlyQuantity += r.quantity * scale;
    line.monthlyCostUsd += r.costUsd * scale;
  }

  const lines = [...groups.values()];
  for (const line of lines) {
    if (line.monthlyQuantity > 0) line.effectiveRate = line.monthlyCostUsd / line.monthlyQuantity;
    const p = line.priceKey && prices.price(line.priceKey.region, line.priceKey.offer, line.priceKey.key);
    if (p && line.monthlyQuantity > 0) {
      // Tiers apply to the account's total volume of a usage type, not one tag's share.
      const total = lines.filter((l) => l.rawUsageType === line.rawUsageType && l.service === line.service).reduce((s, l) => s + l.monthlyQuantity, 0);
      line.listRate = tieredCost(p, total) / total;
    }
  }
  lines.sort((a, b) => b.monthlyCostUsd - a.monthlyCostUsd);

  const byRegion = new Map<string, number>();
  for (const l of lines) byRegion.set(l.region, (byRegion.get(l.region) ?? 0) + l.monthlyCostUsd);
  const primaryRegion = [...byRegion.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "us-east-1";

  return {
    window: { start, end, days: observedDays },
    lines,
    primaryRegion,
    tagValues: [...new Set(lines.map((l) => l.tagValue))].filter(Boolean).sort(),
  };
}

export interface LineFilter {
  usageType?: string | RegExp;
  service?: Service;
  region?: string;
  /** Only lines with this tag value. Omit for all tags. */
  tag?: string;
}

export function findLines(profile: UsageProfile | undefined, f: LineFilter): UsageLine[] {
  if (!profile) return [];
  return profile.lines.filter(
    (l) =>
      (f.usageType === undefined || (typeof f.usageType === "string" ? l.usageType === f.usageType : f.usageType.test(l.usageType))) &&
      (f.service === undefined || l.service === f.service) &&
      (f.region === undefined || l.region === f.region) &&
      (f.tag === undefined || l.tagValue === f.tag),
  );
}

export function sumLines(lines: UsageLine[]): { quantity: number; costUsd: number; listCostUsd: number } {
  return lines.reduce(
    (s, l) => ({
      quantity: s.quantity + l.monthlyQuantity,
      costUsd: s.costUsd + l.monthlyCostUsd,
      listCostUsd: s.listCostUsd + (l.listRate ?? l.effectiveRate ?? 0) * l.monthlyQuantity,
    }),
    { quantity: 0, costUsd: 0, listCostUsd: 0 },
  );
}

/**
 * What you pay relative to list price for these lines (0.72 = 28% below list).
 * 1 when the bill and the price list agree or there's nothing to compare.
 */
export function effectiveRatio(lines: UsageLine[]): number {
  const s = sumLines(lines.filter((l) => l.listRate && l.effectiveRate !== undefined));
  if (s.listCostUsd <= 0) return 1;
  const r = s.costUsd / s.listCostUsd;
  // Within 2% is rounding in the bill, not a discount.
  return Math.abs(r - 1) < 0.02 ? 1 : r;
}
