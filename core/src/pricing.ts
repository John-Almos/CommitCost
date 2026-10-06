import type { DateRange } from "./providers.js";
import type { CloudProvider, CostSource, IsoDate, Service } from "./types.js";

/**
 * Pricing and usage interfaces. Cloud-neutral: AWS keys prices by offer code
 * and usage type; a GCP or Azure price book would key by its own SKU/meter
 * ids and map them the same way.
 */

export interface PriceTier {
  /** Monthly units at which this tier starts (0 for the first tier). */
  fromUnits: number;
  usdPerUnit: number;
}

export interface UnitPrice {
  cloud: CloudProvider;
  region: string;
  /** Price list service, e.g. "AmazonEC2". */
  service: string;
  /** Billable meter, e.g. "BoxUsage:m5.xlarge". The same key the bill's usage types use. */
  usageType: string;
  /** Unit as the price list states it: "Hrs", "GB", "GB-Mo", "Requests", "Lambda-GB-Second". */
  unit: string;
  tiers: PriceTier[];
  source: "snapshot" | "price-list-api" | "override";
  /** Publication date of the price. */
  asOf: string;
}

/** Synchronous price lookup. Live sources load a region up front, then serve from memory. */
export interface PriceBook {
  readonly cloud: CloudProvider;
  /** Shown next to every estimate, e.g. "AWS list prices (bundled snapshot, 2026-10-06)". */
  readonly name: string;
  price(region: string, service: string, usageType: string): UnitPrice | undefined;
  regions(): string[];
}

/** First-tier price: what a marginal unit costs for most accounts. */
export function firstTier(p: UnitPrice): number {
  return p.tiers[0]!.usdPerUnit;
}

/** Cost of `units` in one month, walking the volume tiers. */
export function tieredCost(p: UnitPrice, units: number): number {
  let cost = 0;
  const tiers = [...p.tiers].sort((a, b) => a.fromUnits - b.fromUnits);
  for (let i = 0; i < tiers.length; i++) {
    const lo = tiers[i]!.fromUnits;
    const hi = tiers[i + 1]?.fromUnits ?? Infinity;
    if (units <= lo) break;
    cost += (Math.min(units, hi) - lo) * tiers[i]!.usdPerUnit;
  }
  return cost;
}

/** Inverse of tieredCost: how many units a month cost `usd`. */
export function unitsForCost(p: UnitPrice, usd: number): number {
  let units = 0;
  let left = usd;
  const tiers = [...p.tiers].sort((a, b) => a.fromUnits - b.fromUnits);
  for (let i = 0; i < tiers.length && left > 0; i++) {
    const t = tiers[i]!;
    const width = (tiers[i + 1]?.fromUnits ?? Infinity) - t.fromUnits;
    if (t.usdPerUnit === 0) {
      units += width;
      continue;
    }
    const take = Math.min(width, left / t.usdPerUnit);
    units += take;
    left -= take * t.usdPerUnit;
  }
  return units;
}

/**
 * Usage and cost for one usage type over a period, from the bill. For AWS this
 * is Cost Explorer grouped by USAGE_TYPE (and optionally a tag), with the
 * UsageQuantity and UnblendedCost metrics.
 */
export interface UsageRecord {
  date: IsoDate;
  provider: CloudProvider;
  accountId: string;
  service: Service;
  /** Raw usage type as billed, region prefix included, e.g. "USW2-BoxUsage:m5.large". */
  usageType: string;
  tagKey: string;
  tagValue: string;
  /** Unit of `quantity`, normalized to the price list's ("Hrs", "GB", ...). */
  unit: string;
  quantity: number;
  costUsd: number;
  source: CostSource;
}

export interface UsageProvider {
  readonly name: string;
  getUsage(range: DateRange): Promise<UsageRecord[]>;
}
