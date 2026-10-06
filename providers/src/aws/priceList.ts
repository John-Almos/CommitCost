import { GetProductsCommand, PricingClient, type Filter, type GetProductsCommandOutput } from "@aws-sdk/client-pricing";
import { OFFERS, SnapshotPriceBook, offerKey, type OfferProduct, type PriceSnapshot, type SnapshotEntry } from "@commitcost/engine";
import type { FileCache } from "../cache/fileCache.js";

/** The one call we make. Lets tests pass a fake instead of the SDK client. */
export interface PricingLike {
  send(command: GetProductsCommand): Promise<GetProductsCommandOutput>;
}

export interface AwsPriceListOptions {
  client?: PricingClient | PricingLike;
  cache?: FileCache;
  /** How long fetched prices are reused. AWS changes list prices rarely. */
  ttlMs?: number;
  /** For tests. */
  today?: () => string;
}

/** Server-side filters per offer, so each region is a handful of requests rather than every product. */
const QUERIES: Record<string, Filter[][]> = {
  AmazonEC2: [
    [
      { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
      { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
      { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
      { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
    ],
    [{ Type: "TERM_MATCH", Field: "productFamily", Value: "NAT Gateway" }],
    [{ Type: "TERM_MATCH", Field: "productFamily", Value: "Storage" }],
  ],
  AmazonRDS: [
    [
      { Type: "TERM_MATCH", Field: "licenseModel", Value: "No license required" },
      { Type: "TERM_MATCH", Field: "productFamily", Value: "Database Instance" },
    ],
    [{ Type: "TERM_MATCH", Field: "productFamily", Value: "Database Storage" }],
  ],
  AWSLambda: [[]],
  AmazonDynamoDB: [[]],
  AmazonS3: [[]],
  AWSDataTransfer: [[]],
  AmazonCloudWatch: [[{ Type: "TERM_MATCH", Field: "productFamily", Value: "Data Payload" }], [{ Type: "TERM_MATCH", Field: "productFamily", Value: "Storage Snapshot" }]],
};

interface PriceListItem {
  product: { attributes: OfferProduct & Record<string, string> };
  publicationDate?: string;
  terms?: { OnDemand?: Record<string, { priceDimensions: Record<string, { unit: string; beginRange?: string; pricePerUnit: { USD?: string } }> }> };
}

/**
 * Current on-demand list prices from the AWS Price List API
 * (`pricing:GetProducts`), in the same shape as the bundled snapshot. One
 * region is loaded at a time and cached on disk for a week.
 */
export class AwsPriceList {
  private readonly client: PricingLike;
  /** Requests actually sent to AWS (cache misses). */
  requestCount = 0;

  constructor(private readonly options: AwsPriceListOptions = {}) {
    // The Price List API is served from us-east-1 (and a few others), whatever region you price.
    this.client = options.client ?? new PricingClient({ region: "us-east-1" });
  }

  /** A price book for these regions. Falls back to nothing: callers decide whether to use the snapshot instead. */
  async priceBook(regions: string[]): Promise<SnapshotPriceBook> {
    const today = this.options.today?.() ?? new Date().toISOString().slice(0, 10);
    const snapshot: PriceSnapshot = { source: "AWS Price List API (GetProducts)", url: "pricing.us-east-1.amazonaws.com", generatedAt: today, publications: {}, regions: {} };
    for (const region of regions) {
      const { prices, publications } = await this.loadRegion(region);
      snapshot.regions[region] = prices;
      Object.assign(snapshot.publications, publications);
    }
    return new SnapshotPriceBook(snapshot, "price-list-api");
  }

  async loadRegion(region: string): Promise<{ prices: Record<string, Record<string, SnapshotEntry>>; publications: Record<string, string> }> {
    const cacheKey = JSON.stringify({ v: 1, priceList: region });
    const cached = this.options.cache?.get<{ prices: Record<string, Record<string, SnapshotEntry>>; publications: Record<string, string> }>(cacheKey);
    if (cached) return cached;

    const prices: Record<string, Record<string, SnapshotEntry>> = {};
    const publications: Record<string, string> = {};
    for (const offer of Object.keys(OFFERS)) {
      const tiers = new Map<string, { u: string; t: [number, number][] }>();
      for (const filters of QUERIES[offer] ?? [[]]) {
        for (const item of await this.products(offer, [{ Type: "TERM_MATCH", Field: "regionCode", Value: region }, ...filters])) {
          const key = offerKey(offer, item.product.attributes);
          if (!key) continue;
          if (item.publicationDate) publications[offer] = item.publicationDate.slice(0, 10);
          for (const term of Object.values(item.terms?.OnDemand ?? {})) {
            for (const dim of Object.values(term.priceDimensions)) {
              const usd = Number(dim.pricePerUnit.USD);
              if (!Number.isFinite(usd)) continue;
              const e = tiers.get(key) ?? { u: dim.unit, t: [] };
              const from = Number(dim.beginRange ?? 0);
              if (!e.t.some(([f]) => f === from)) e.t.push([from, usd]);
              tiers.set(key, e);
            }
          }
        }
      }
      prices[offer] = Object.fromEntries(
        [...tiers].map(([k, e]) => {
          const t = e.t.sort((a, b) => a[0] - b[0]);
          return [k, t.length === 1 && t[0]![0] === 0 ? { u: e.u, p: t[0]![1] } : { u: e.u, t }];
        }),
      );
    }
    this.options.cache?.set(cacheKey, { prices, publications }, this.options.ttlMs ?? 7 * 24 * 3600 * 1000);
    return { prices, publications };
  }

  private async products(serviceCode: string, filters: Filter[]): Promise<PriceListItem[]> {
    const out: PriceListItem[] = [];
    let token: string | undefined;
    do {
      this.requestCount++;
      const page = await this.client.send(new GetProductsCommand({ ServiceCode: serviceCode, Filters: filters, FormatVersion: "aws_v1", NextToken: token, MaxResults: 100 }));
      for (const raw of page.PriceList ?? []) out.push(JSON.parse(typeof raw === "string" ? raw : String(raw)) as PriceListItem);
      token = page.NextToken;
    } while (token);
    return out;
  }
}
