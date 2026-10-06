import type { IsoDate, PriceBook, UsageRecord } from "@commitcost/core";
import { loadUsageRecords, readLocalPrices } from "@commitcost/db";
import { SnapshotPriceBook, buildUsageProfile, costContext, networkPath, type CostContext, type PriceSnapshot } from "@commitcost/engine";
import { db } from "./db";

let bundled: PriceBook | undefined;

/** Live prices saved by `npm run sync` (COMMITCOST_PRICING=live), else the bundled snapshot. */
export function priceBook(): PriceBook {
  const live = readLocalPrices<PriceSnapshot>();
  if (live) return new SnapshotPriceBook(live, "price-list-api");
  return (bundled ??= new SnapshotPriceBook());
}

export async function usageRecords(): Promise<UsageRecord[]> {
  return loadUsageRecords(db);
}

/** Cost model inputs as of `end` (default: the latest day of usage): price book plus the two weeks of usage before it. */
export function contextAt(records: UsageRecord[], end?: IsoDate, prices = priceBook()): CostContext {
  return costContext({ prices, usage: buildUsageProfile(records, prices, { end }) });
}

export async function currentCostContext(): Promise<CostContext> {
  return contextAt(await usageRecords());
}

export interface PathRow {
  path: string;
  description: string;
  gbPerMonth: number;
  usdPerMonth: number;
  paidPerGb: number;
  listPerGb?: number;
}

/** Everything the "How costs are calculated" page shows. */
export async function getCostModel() {
  const records = await usageRecords();
  const prices = priceBook();
  const ctx = contextAt(records, undefined, prices);
  const profile = ctx.usage;
  const region = ctx.region;

  const sample: { label: string; offer: string; key: string }[] = [
    { label: "EC2 m5.large, Linux on-demand", offer: "AmazonEC2", key: "BoxUsage:m5.large" },
    { label: "RDS db.r6g.large PostgreSQL, Multi-AZ", offer: "AmazonRDS", key: "Multi-AZUsage:db.r6g.large@postgres" },
    { label: "Lambda compute (x86)", offer: "AWSLambda", key: "Lambda-GB-Second" },
    { label: "Lambda requests", offer: "AWSLambda", key: "Request" },
    { label: "DynamoDB on-demand read", offer: "AmazonDynamoDB", key: "ReadRequestUnits" },
    { label: "DynamoDB on-demand write", offer: "AmazonDynamoDB", key: "WriteRequestUnits" },
    { label: "S3 STANDARD storage", offer: "AmazonS3", key: "TimedStorage-ByteHrs" },
    { label: "Cross-AZ transfer (each direction)", offer: "AWSDataTransfer", key: "DataTransfer-Regional-Bytes" },
    { label: "Internet egress", offer: "AWSDataTransfer", key: "DataTransfer-Out-Bytes" },
    { label: "NAT gateway, per hour", offer: "AmazonEC2", key: "NatGateway-Hours" },
    { label: "NAT gateway, per GB processed", offer: "AmazonEC2", key: "NatGateway-Bytes" },
    { label: "CloudWatch Logs ingestion", offer: "AmazonCloudWatch", key: "Logs-Ingestion-Bytes" },
  ];
  const unitPrices = sample.map((s) => ({ ...s, price: prices.price(region, s.offer, s.key) })).filter((s) => s.price);

  const paths: PathRow[] = [];
  for (const l of profile?.lines ?? []) {
    const path = networkPath(l.rawUsageType);
    if (!path || l.monthlyQuantity <= 0) continue;
    const existing = paths.find((p) => p.description === l.description);
    if (existing) {
      existing.gbPerMonth += l.monthlyQuantity;
      existing.usdPerMonth += l.monthlyCostUsd;
      existing.paidPerGb = existing.usdPerMonth / existing.gbPerMonth;
    } else {
      paths.push({ path, description: l.description, gbPerMonth: l.monthlyQuantity, usdPerMonth: l.monthlyCostUsd, paidPerGb: l.monthlyCostUsd / l.monthlyQuantity, listPerGb: l.listRate });
    }
  }
  paths.sort((a, b) => b.usdPerMonth - a.usdPerMonth);

  return { prices, region, profile, unitPrices, paths, assumptions: ctx.assumptions };
}
