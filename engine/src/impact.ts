import type { Service } from "@commitcost/core";
import { instanceUnits } from "./diff/detectors.js";
import type { DiffFinding } from "./diff/types.js";

/**
 * Rough, order-of-magnitude monthly cost for a diff finding. Prices are
 * us-east-1 on-demand list prices; every estimate states its assumptions so a
 * reviewer can rescale it to their own traffic.
 */
export interface ImpactEstimate {
  /** One line, e.g. "≈ +$420/month". */
  summary: string;
  /** Point estimate when the diff gives enough to compute one. */
  monthlyUsd?: number;
  assumptions: string;
}

export interface ImpactContext {
  /** Current monthly spend per service, if known (e.g. from synced Cost Explorer data). */
  serviceSpend?: Partial<Record<Service, number>>;
}

const HOURS_PER_MONTH = 730;
/** General-purpose (m-family) on-demand price per size unit (medium = 1) per hour. */
const EC2_PER_UNIT_HOUR = 0.048;
const RDS_PER_UNIT_HOUR = 0.076;
const LAMBDA_GB_SECOND = 0.0000166667;
const LAMBDA_PROVISIONED_GB_SECOND = 0.0000041667;
const DDB_RCU_MONTH = 0.00013 * HOURS_PER_MONTH;
const DDB_WCU_MONTH = 0.00065 * HOURS_PER_MONTH;
const DDB_ON_DEMAND_READ_PER_MILLION = 0.125;

const money = (n: number) => {
  const abs = Math.abs(n);
  const s = abs >= 100 ? Math.round(abs).toLocaleString("en-US") : abs >= 10 ? abs.toFixed(0) : abs.toFixed(2);
  return `${n < 0 ? "-" : "+"}$${s}`;
};

/** Pulls `key = N` / `key: N` (new value) out of a finding's snippet. */
function numberIn(snippet: string, keys: RegExp): number | null {
  for (const line of snippet.split("\n")) {
    if (line.startsWith("-")) continue;
    const m = line.match(new RegExp(`\\b(?:${keys.source})["']?\\s*[:=]\\s*["']?(\\d+)`, "i"));
    if (m) return Number(m[1]);
  }
  return null;
}

function stringIn(snippet: string, keys: RegExp): string | null {
  for (const line of snippet.split("\n")) {
    if (line.startsWith("-")) continue;
    const m = line.match(new RegExp(`\\b(?:${keys.source})["']?\\s*[:=]\\s*["']?([\\w.-]+)`, "i"));
    if (m) return m[1]!;
  }
  return null;
}

/** "- key = old" and "+ key = new" values from a snippet. */
function changedValues(snippet: string, key: RegExp): { from: string; to: string } | null {
  const lines = snippet.split("\n");
  const re = new RegExp(`\\b(?:${key.source})["']?\\s*[:=]\\s*["']?([\\w.-]+)`, "i");
  const from = lines.find((l) => l.startsWith("-") && re.test(l))?.match(re)?.[1];
  const to = lines.find((l) => l.startsWith("+") && re.test(l))?.match(re)?.[1];
  return from && to ? { from, to } : null;
}

const COUNT_KEYS = /desired_capacity|desiredCapacity|desiredCount|desired_count|min_size|minSize|replicas|instance_count|count/;
const SIZE_KEYS = /instance_type|instanceType|InstanceType|instance_class|instanceClass|DBInstanceClass|node_type/;

export function estimateImpact(f: DiffFinding, ctx: ImpactContext = {}): ImpactEstimate {
  const spend = f.services.length === 1 ? ctx.serviceSpend?.[f.services[0]!] : undefined;
  if (spend && f.costRatio && f.costRatio > 1 && (f.detector === "lambda-config" || f.detector === "compute-size")) {
    const upper = spend * (f.costRatio - 1);
    return {
      summary: `up to ${money(upper)}/month`,
      monthlyUsd: upper,
      assumptions: `Upper bound: assumes this resource is all of your current ${f.services[0]} spend (${money(spend).slice(1)}/month) and scales ${f.costRatio.toFixed(1)}x.`,
    };
  }

  switch (f.detector) {
    case "compute-size": {
      const sizes = changedValues(f.snippet, SIZE_KEYS);
      const from = sizes && instanceUnits(sizes.from);
      const to = sizes && instanceUnits(sizes.to);
      if (from == null || to == null) break;
      const count = numberIn(f.snippet, COUNT_KEYS) ?? 1;
      const rate = f.services[0] === "RDS" ? RDS_PER_UNIT_HOUR : EC2_PER_UNIT_HOUR;
      const monthly = (to - from) * rate * HOURS_PER_MONTH * count;
      return {
        summary: `≈ ${money(monthly)}/month`,
        monthlyUsd: monthly,
        assumptions: `${count} instance${count === 1 ? "" : "s"} running 24/7 at general-purpose on-demand pricing (~$${(rate * 2).toFixed(3)}/h per "large"). Reserved or Spot pricing lowers it.`,
      };
    }
    case "capacity-increase": {
      if (f.services[0] === "DynamoDB" && f.costRatio) {
        const vals = changedValues(f.snippet, /read_capacity|write_capacity|ReadCapacityUnits|WriteCapacityUnits/);
        if (!vals) break;
        const write = /write/i.test(f.title);
        const monthly = (Number(vals.to) - Number(vals.from)) * (write ? DDB_WCU_MONTH : DDB_RCU_MONTH);
        return { summary: `≈ ${money(monthly)}/month`, monthlyUsd: monthly, assumptions: `Provisioned ${write ? "WCU" : "RCU"} at $${(write ? DDB_WCU_MONTH : DDB_RCU_MONTH).toFixed(3)} per unit-month, without auto scaling.` };
      }
      if (f.services[0] === "EC2") {
        const vals = changedValues(f.snippet, COUNT_KEYS);
        const size = stringIn(f.snippet, SIZE_KEYS);
        const units = size ? instanceUnits(size) : null;
        if (!vals) break;
        const extra = Number(vals.to) - Number(vals.from);
        if (units != null) {
          const monthly = extra * units * EC2_PER_UNIT_HOUR * HOURS_PER_MONTH;
          return { summary: `≈ ${money(monthly)}/month`, monthlyUsd: monthly, assumptions: `${extra} more ${size} instance${extra === 1 ? "" : "s"} running 24/7 at on-demand pricing.` };
        }
        return { summary: `≈ +$70–$280/month per extra instance`, assumptions: `${extra} more instances; range covers large to 2xlarge general-purpose on-demand.` };
      }
      break;
    }
    case "lambda-config": {
      if (/memory/i.test(f.title)) {
        const vals = changedValues(f.snippet, /memorySize|memory_size|MemorySize|memory/);
        if (!vals) break;
        const deltaGb = (Number(vals.to) - Number(vals.from)) / 1024;
        const perMillion = deltaGb * 1_000_000 * LAMBDA_GB_SECOND;
        return {
          summary: `≈ ${money(perMillion)} per million 1-second invocations`,
          assumptions: "Duration unchanged by the extra memory; x86 pricing. Multiply by your monthly invocations (millions) × average duration (s).",
        };
      }
      if (/provisioned/i.test(f.title)) {
        const vals = changedValues(f.snippet, /provisioned\w*/);
        if (!vals) break;
        const monthly = (Number(vals.to) - Number(vals.from)) * LAMBDA_PROVISIONED_GB_SECOND * 2_628_000;
        return { summary: `≈ ${money(monthly)}/month per GB of function memory`, monthlyUsd: monthly, assumptions: "Provisioned concurrency billed around the clock per GB configured, before invocation charges." };
      }
      break;
    }
    case "query-in-loop": {
      if (f.services.includes("DynamoDB")) {
        const monthly = 49 * DDB_ON_DEMAND_READ_PER_MILLION;
        return {
          summary: `≈ ${money(monthly)}/month per million requests to this code path`,
          monthlyUsd: undefined,
          assumptions: "50 items per loop (49 extra reads per request), on-demand eventually consistent reads at $0.125 per million.",
        };
      }
      return {
        summary: "~50x more queries per request on this path",
        assumptions: "A loop over 50 items makes 51 queries instead of 1–2. RDS isn't billed per query, so the cost shows up as a bigger instance or more read replicas once load grows.",
      };
    }
    case "removed-cache":
      return {
        summary: f.services.includes("DynamoDB") ? "≈ +$33/month per 100 req/s of cache hits" : "load scales with traffic instead of cache misses",
        assumptions: f.services.includes("DynamoDB")
          ? "Each former cache hit becomes one on-demand eventually consistent read: 100 req/s ≈ 260M reads/month at $0.125 per million."
          : "Depends on the cache hit rate before the change.",
      };
    case "schedule-frequency":
      return f.costRatio
        ? { summary: `${f.costRatio.toFixed(0)}x this job's current cost`, assumptions: "Each run costs about the same as before." }
        : { summary: "new recurring cost", assumptions: "Each run's cost is unknown from the diff." };
    case "cross-region-transfer":
      return { summary: "≈ +$43/month per TB written", assumptions: "$0.02/GB inter-region transfer plus a second STANDARD copy at $0.023/GB-month; replication request fees extra." };
    case "s3-lifecycle-removed":
      return { summary: "+$23/month for every TB that no longer expires, growing each month", assumptions: "S3 STANDARD at $0.023/GB-month." };
    case "hot-path-logging":
      return { summary: "≈ +$15/month per million iterations a day", assumptions: "1 KB per log line, CloudWatch Logs ingestion at $0.50/GB (30 GB/month)." };
    case "removed-batching":
      return { summary: "grows with data size", assumptions: "Unbounded reads scale with table size rather than page size." };
  }
  return { summary: "unknown from the diff", assumptions: "" };
}
