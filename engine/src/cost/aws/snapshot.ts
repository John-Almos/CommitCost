import type { PriceBook, PriceTier, UnitPrice } from "@commitcost/core";
import data from "./snapshot.json" with { type: "json" };

/** A price as stored in the snapshot: one flat rate, or volume tiers [fromUnits, usdPerUnit]. */
export type SnapshotEntry = { u: string; p: number; t?: undefined } | { u: string; t: [number, number][]; p?: undefined };

/**
 * On-demand AWS list prices, keyed by region, then offer code (AmazonEC2,
 * AWSLambda, ...), then usage type without its region prefix. RDS instance
 * prices add the engine: "InstanceUsage:db.r6g.large@postgres".
 * Built by scripts/build-price-snapshot.ts from the public Price List files.
 */
export interface PriceSnapshot {
  source: string;
  url: string;
  /** YYYY-MM-DD the snapshot was built. */
  generatedAt: string;
  /** Publication date of each offer file used. */
  publications: Record<string, string>;
  regions: Record<string, Record<string, Record<string, SnapshotEntry>>>;
}

export const AWS_PRICE_SNAPSHOT = data as unknown as PriceSnapshot;

/** Prices from a snapshot-shaped object: the bundled file or one fetched live. */
export class SnapshotPriceBook implements PriceBook {
  readonly cloud = "aws" as const;

  constructor(
    readonly snapshot: PriceSnapshot = AWS_PRICE_SNAPSHOT,
    readonly sourceKind: UnitPrice["source"] = "snapshot",
    readonly name = `AWS list prices (${sourceKind === "snapshot" ? `bundled snapshot, ${snapshot.generatedAt}` : `Price List API, ${snapshot.generatedAt}`})`,
  ) {}

  regions(): string[] {
    return Object.keys(this.snapshot.regions);
  }

  price(region: string, service: string, usageType: string): UnitPrice | undefined {
    const e = this.snapshot.regions[region]?.[service]?.[usageType];
    if (!e) return undefined;
    const tiers: PriceTier[] = e.t ? e.t.map(([fromUnits, usdPerUnit]) => ({ fromUnits, usdPerUnit })) : [{ fromUnits: 0, usdPerUnit: e.p }];
    return {
      cloud: "aws",
      region,
      service,
      usageType,
      unit: e.u,
      tiers,
      source: this.sourceKind,
      asOf: this.snapshot.publications[service] || this.snapshot.generatedAt,
    };
  }
}
