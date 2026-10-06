import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadUsageRecords, readLocalPrices, type PrismaClient } from "@commitcost/db";
import {
  SnapshotPriceBook,
  buildUsageProfile,
  effectiveRatio,
  fmtRate,
  fmtUsd,
  type CostProfileFile,
  type PriceSnapshot,
  type UsageProfile,
} from "@commitcost/engine";
import type { PriceBook } from "@commitcost/core";
import { bold, dim } from "./render.js";

/** Live prices saved by `sync` (COMMITCOST_PRICING=live), else the bundled snapshot. */
export function localPriceBook(): PriceBook {
  const live = readLocalPrices<PriceSnapshot>();
  return live ? new SnapshotPriceBook(live, "price-list-api") : new SnapshotPriceBook();
}

/** Builds the usage profile from stored usage and writes it for the GitHub Action's `cost-profile` input. */
export async function exportProfile(db: PrismaClient, out: string, days?: number): Promise<CostProfileFile> {
  const records = await loadUsageRecords(db);
  if (records.length === 0) throw new Error("No usage stored yet. Run `npm run seed` (mock) or `npm run sync` (real) first.");
  const prices = localPriceBook();
  const usage = buildUsageProfile(records, prices, { days });
  const file: CostProfileFile = { version: 1, generatedAt: new Date().toISOString(), region: usage?.primaryRegion, priceSource: prices.name, usage };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

export function renderProfile(p: UsageProfile, prices: string): string {
  const lines = [
    bold(`Usage profile ${p.window.start} → ${p.window.end} (${p.window.days} days, scaled to a 730-hour month)`),
    dim(`Main region ${p.primaryRegion}. List prices: ${prices}.`),
    "",
  ];
  const rows = p.lines.slice(0, 15).map((l) => {
    const vs = l.listRate && l.effectiveRate !== undefined ? effectiveRatio([l]) : 1;
    return `  ${`${l.service}${l.tagValue ? ` app=${l.tagValue}` : ""}`.padEnd(22)} ${l.description.padEnd(44)} ${String(Math.round(l.monthlyQuantity).toLocaleString("en-US")).padStart(16)} ${l.unit.padEnd(18)} ${fmtUsd(l.monthlyCostUsd).padStart(9)}/mo  ${l.effectiveRate !== undefined ? fmtRate(l.effectiveRate) : ""}${vs !== 1 ? dim(` (${Math.round((1 - vs) * 100)}% below list)`) : ""}`;
  });
  return [...lines, ...rows, p.lines.length > 15 ? dim(`  … ${p.lines.length - 15} more usage types`) : ""].join("\n");
}
