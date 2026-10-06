/**
 * Builds engine/src/cost/aws/snapshot.json from AWS's public Price List bulk
 * files (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/...). No AWS
 * credentials are needed. The snapshot is what mock mode, tests and the
 * GitHub Action price with; a connected account can use the live Price List
 * API instead (providers/src/aws/priceList.ts).
 *
 *   npx tsx scripts/build-price-snapshot.ts [region ...]
 *
 * EC2's offer file is ~500 MB per region, so it is streamed and filtered
 * line by line rather than downloaded.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { OFFERS, offerKey, type OfferProduct } from "../engine/src/cost/aws/offers.js";
import type { PriceSnapshot, SnapshotEntry } from "../engine/src/cost/aws/snapshot.js";

const BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";
const DEFAULT_REGIONS = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-2", "ap-northeast-1"];

type Row = Record<string, string>;

/** CSV columns -> the Price List API attribute names the shared filters use. */
const toProduct = (r: Row): OfferProduct => ({
  usagetype: r.usageType ?? "",
  operation: r.operation,
  operatingSystem: r["Operating System"],
  tenancy: r.Tenancy,
  preInstalledSw: r["Pre Installed S/W"],
  capacitystatus: r.CapacityStatus,
  instanceType: r["Instance Type"],
  licenseModel: r["License Model"],
});

/** Splits one CSV line where every field is double-quoted. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      let field = "";
      for (;;) {
        const q = line.indexOf('"', j);
        if (q === -1) {
          field += line.slice(j);
          j = line.length;
          break;
        }
        field += line.slice(j, q);
        if (line[q + 1] === '"') {
          field += '"';
          j = q + 2;
        } else {
          j = q + 1;
          break;
        }
      }
      out.push(field);
      i = j + 1; // skip comma
    } else {
      const c = line.indexOf(",", i);
      out.push(c === -1 ? line.slice(i) : line.slice(i, c));
      i = c === -1 ? line.length : c + 1;
    }
  }
  return out;
}

async function readOffer(offer: string, region: string) {
  const res = await fetch(`${BASE}/${offer}/current/${region}/index.csv`);
  if (!res.ok || !res.body) throw new Error(`${offer} ${region}: HTTP ${res.status}`);
  const lines = createInterface({ input: Readable.fromWeb(res.body as never), crlfDelay: Infinity });
  let header: string[] | null = null;
  let publication = "";
  const entries: Record<string, SnapshotEntry & { tiers?: [number, number][] }> = {};
  let n = 0;
  for await (const line of lines) {
    n++;
    if (!header) {
      if (line.startsWith('"Publication Date"')) publication = parseCsvLine(line)[1] ?? "";
      if (line.startsWith('"SKU"')) header = parseCsvLine(line);
      continue;
    }
    // Cheap pre-filter before parsing: EC2 has millions of reserved/savings rows.
    if (!line.includes('"OnDemand"')) continue;
    const cells = parseCsvLine(line);
    const row: Row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    if (row.TermType !== "OnDemand" || row.Currency !== "USD") continue;
    const key = offerKey(offer, toProduct(row));
    if (!key) continue;
    const price = Number(row.PricePerUnit);
    const from = Number(row.StartingRange || 0);
    const e = (entries[key] ??= { u: row.Unit ?? "", t: [] as [number, number][] });
    if (!e.t!.some(([f]) => f === from)) e.t!.push([from, price]);
  }
  // Single-tier prices are stored as a plain number.
  const out: Record<string, SnapshotEntry> = {};
  for (const [k, e] of Object.entries(entries)) {
    const tiers = e.t!.sort((a, b) => a[0] - b[0]);
    out[k] = tiers.length === 1 && tiers[0]![0] === 0 ? { u: e.u, p: tiers[0]![1] } : { u: e.u, t: tiers };
  }
  console.log(`  ${offer} ${region}: ${Object.keys(out).length} prices from ${n.toLocaleString()} lines`);
  return { publication, entries: out };
}

async function main() {
  const regions = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_REGIONS;
  const snapshot: PriceSnapshot = {
    source: "AWS Price List bulk API, public on-demand offer files",
    url: BASE,
    generatedAt: new Date().toISOString().slice(0, 10),
    publications: {},
    regions: {},
  };
  for (const region of regions) {
    console.log(region);
    const prices: Record<string, Record<string, SnapshotEntry>> = {};
    // One region at a time: EC2 alone is ~500 MB per region.
    await Promise.all(
      Object.keys(OFFERS).map(async (offer) => {
        const { publication, entries } = await readOffer(offer, region);
        prices[offer] = entries;
        snapshot.publications[offer] = publication.slice(0, 10);
      }),
    );
    snapshot.regions[region] = Object.fromEntries(Object.keys(OFFERS).map((o) => [o, prices[o]!]));
  }
  const out = join(dirname(fileURLToPath(import.meta.url)), "../engine/src/cost/aws/snapshot.json");
  writeFileSync(out, `${JSON.stringify(snapshot)}\n`);
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
