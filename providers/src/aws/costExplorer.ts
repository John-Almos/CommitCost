import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GetCostAndUsageCommandInput,
  type GetCostAndUsageCommandOutput,
  type GroupDefinition,
} from "@aws-sdk/client-cost-explorer";
import type { CostProvider, CostRecord, DateRange, IsoDate } from "@commitcost/core";
import { addDays, toIsoDate } from "@commitcost/core";
import type { FileCache } from "../cache/fileCache.js";
import { mapAwsService } from "./services.js";

export type CostMetric = "UnblendedCost" | "AmortizedCost" | "NetUnblendedCost" | "NetAmortizedCost";

/** The one call we make. Lets tests pass a fake instead of the SDK client. */
export interface CostExplorerLike {
  send(command: GetCostAndUsageCommand): Promise<GetCostAndUsageCommandOutput>;
}

export interface AwsCostExplorerOptions {
  /** Cost-allocation tag to group by, e.g. "app". Omit to group by service only. */
  tagKey?: string;
  metric?: CostMetric;
  /** Stored on every record. Cost Explorer returns the payer account's view. */
  accountId?: string;
  cache?: FileCache;
  client?: CostExplorerLike;
  /** For tests. */
  today?: () => IsoDate;
}

/** Cost Explorer revises recent days for up to ~72h; don't cache those for long. */
const SETTLED_AFTER_DAYS = 3;
const RECENT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Daily costs from AWS Cost Explorer `GetCostAndUsage`, grouped by service and
 * optionally by one cost-allocation tag. Credentials come from the standard
 * AWS chain (env vars, profile, SSO, instance role). Only needs
 * `ce:GetCostAndUsage`.
 */
export class AwsCostExplorerProvider implements CostProvider {
  readonly name = "aws-cost-explorer";
  private readonly client: CostExplorerLike;
  private readonly metric: CostMetric;
  private readonly today: () => IsoDate;
  /** Requests actually sent to AWS (cache misses), for logging and tests. */
  requestCount = 0;

  constructor(private readonly options: AwsCostExplorerOptions = {}) {
    // Cost Explorer's API endpoint lives in us-east-1 regardless of where resources run.
    this.client = options.client ?? new CostExplorerClient({ region: "us-east-1" });
    this.metric = options.metric ?? "UnblendedCost";
    this.today = options.today ?? (() => toIsoDate(new Date()));
  }

  async getDailyCosts(range: DateRange): Promise<CostRecord[]> {
    const groupBy: GroupDefinition[] = [{ Type: "DIMENSION", Key: "SERVICE" }];
    if (this.options.tagKey) groupBy.push({ Type: "TAG", Key: this.options.tagKey });

    const input: GetCostAndUsageCommandInput = {
      // Cost Explorer's End is exclusive.
      TimePeriod: { Start: range.start, End: addDays(range.end, 1) },
      Granularity: "DAILY",
      Metrics: [this.metric],
      GroupBy: groupBy,
    };

    const pages = await this.fetchAllPages(input);
    return this.toRecords(pages);
  }

  private async fetchAllPages(input: GetCostAndUsageCommandInput): Promise<GetCostAndUsageCommandOutput[]> {
    const key = JSON.stringify({ v: 1, input });
    const cached = this.options.cache?.get<GetCostAndUsageCommandOutput[]>(key);
    if (cached) return cached;

    const pages: GetCostAndUsageCommandOutput[] = [];
    let token: string | undefined;
    do {
      this.requestCount++;
      const page = await this.client.send(new GetCostAndUsageCommand({ ...input, NextPageToken: token }));
      pages.push({ ResultsByTime: page.ResultsByTime, NextPageToken: page.NextPageToken, $metadata: {} });
      token = page.NextPageToken;
    } while (token);

    const settled = input.TimePeriod!.End! <= addDays(this.today(), -SETTLED_AFTER_DAYS);
    this.options.cache?.set(key, pages, settled ? null : RECENT_TTL_MS);
    return pages;
  }

  private toRecords(pages: GetCostAndUsageCommandOutput[]): CostRecord[] {
    // Several AWS services map to one CommitCost service, so sum by key.
    const sums = new Map<string, CostRecord>();
    const tagKey = this.options.tagKey ?? "";

    for (const page of pages) {
      for (const result of page.ResultsByTime ?? []) {
        const date = result.TimePeriod?.Start;
        if (!date) continue;
        for (const group of result.Groups ?? []) {
          const [serviceName = "", tagPart] = group.Keys ?? [];
          const amount = Number(group.Metrics?.[this.metric]?.Amount ?? 0);
          if (!Number.isFinite(amount)) continue;
          const service = mapAwsService(serviceName);
          // Tag keys come back as "app$api"; "app$" means untagged.
          const tagValue = tagPart ? tagPart.slice(tagPart.indexOf("$") + 1) : "";
          const k = `${date}|${service}|${tagValue}`;
          const existing = sums.get(k);
          if (existing) {
            existing.amountUsd += amount;
          } else {
            sums.set(k, {
              date,
              provider: "aws",
              accountId: this.options.accountId ?? "default",
              service,
              tagKey,
              tagValue,
              amountUsd: amount,
              source: "aws-cost-explorer",
            });
          }
        }
      }
    }
    return [...sums.values()]
      .map((r) => ({ ...r, amountUsd: Math.round(r.amountUsd * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.service.localeCompare(b.service) || a.tagValue.localeCompare(b.tagValue));
  }
}
