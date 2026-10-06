import { firstTier, type UnitPrice } from "@commitcost/core";
import { scheduleIntervalMinutes } from "../diff/detectors.js";
import type { DiffFinding } from "../diff/types.js";
import { usageRegionCode } from "./aws/regions.js";
import type { CostAssumptions, CostContext } from "./context.js";
import { COUNT_KEYS, SIZE_KEYS, changedValues, instanceCountIn, numberIn, regionInDiff, regionsInDiff, stringIn } from "./diffValues.js";
import { HOURS_PER_MONTH, effectiveRatio, findLines, sumLines, type UsageLine } from "./profile.js";
import type { CostEstimate, EstimateBasis, EstimateInput } from "./types.js";

const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600;

// ---------------------------------------------------------------- formatting

export function fmtUsd(n: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(n);
  const s = abs >= 100 ? Math.round(abs).toLocaleString("en-US") : abs >= 1 ? abs.toFixed(2) : abs >= 0.01 ? abs.toFixed(3) : abs.toPrecision(3);
  return `${n < 0 ? "-" : opts.sign ? "+" : ""}$${s}`;
}

/** A unit price: "$0.384", "$0.0000166667". */
export function fmtRate(n: number): string {
  if (n === 0) return "$0";
  if (n >= 0.01) return `$${Number(n.toPrecision(4))}`;
  return `$${n.toFixed(12).replace(/0+$/, "")}`;
}

function fmtQty(n: number): string {
  if (n >= 1e9) return `${Number((n / 1e9).toPrecision(3))}B`;
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(3))}M`;
  if (n >= 100) return Math.round(n).toLocaleString("en-US");
  return String(Number(n.toPrecision(3)));
}

const UNIT_NAMES: Record<string, string> = {
  Hrs: "hour",
  "GB-Mo": "GB-month",
  "Lambda-GB-Second": "GB-second",
  Requests: "request",
  ReadRequestUnits: "read request unit",
  WriteRequestUnits: "write request unit",
  "ReadCapacityUnit-Hrs": "RCU-hour",
  "WriteCapacityUnit-Hrs": "WCU-hour",
  GB: "GB",
};
const unitName = (u: string) => UNIT_NAMES[u] ?? u;

// ---------------------------------------------------------------- calculation builder

/** Collects inputs and assumptions while an estimator works, so each number is traceable. */
class Calc {
  readonly inputs: EstimateInput[] = [];
  readonly assumptions: string[] = [];

  constructor(
    readonly ctx: CostContext,
    readonly region: string,
  ) {}

  diff<T extends number | string>(label: string, value: T, unit?: string, ref?: string): T {
    this.inputs.push({ label, value, unit, source: "diff", ref });
    return value;
  }

  usage(label: string, value: number, unit: string, ref: string): number {
    this.inputs.push({ label, value: Number(value.toPrecision(4)), unit, source: "usage", ref });
    return value;
  }

  assume<K extends keyof CostAssumptions>(key: K, label: string, unit?: string): NonNullable<CostAssumptions[K]> {
    const value = this.ctx.assumptions[key] as NonNullable<CostAssumptions[K]>;
    this.inputs.push({ label, value: value as number | string, unit, source: this.ctx.configured.has(key) ? "config" : "default", ref: `assumptions.${key}` });
    return value;
  }

  /** A configured value, or undefined (nothing recorded) when it isn't set. */
  configured<K extends keyof CostAssumptions>(key: K, label: string, unit?: string): CostAssumptions[K] | undefined {
    if (!this.ctx.configured.has(key)) return undefined;
    return this.assume(key, label, unit) as CostAssumptions[K];
  }

  /**
   * Unit price from the price book. `volume` (monthly units already used)
   * picks the volume tier the next unit lands in; without it, free tiers are
   * skipped, since an account big enough to care is past them.
   */
  price(offer: string, key: string, label: string, opts: { region?: string; volume?: number } = {}): number | undefined {
    let region = opts.region ?? this.region;
    let p: UnitPrice | undefined = this.ctx.prices.price(region, offer, key);
    if (!p && region !== "us-east-1") {
      p = this.ctx.prices.price("us-east-1", offer, key);
      if (p) {
        this.assumptions.push(`No ${region} price for ${key} in ${this.ctx.prices.name}; used us-east-1.`);
        region = "us-east-1";
      }
    }
    if (!p) return undefined;
    const tiers = [...p.tiers].sort((a, b) => a.fromUnits - b.fromUnits);
    const usd =
      opts.volume !== undefined
        ? [...tiers].reverse().find((t) => t.fromUnits <= opts.volume!)!.usdPerUnit
        : (tiers.find((t) => t.usdPerUnit > 0) ?? tiers[0]!).usdPerUnit;
    if (opts.volume === undefined && tiers[0]!.usdPerUnit === 0 && usd > 0) this.assumptions.push(`${key}: priced beyond the free tier.`);
    this.inputs.push({ label, value: usd, unit: `$/${unitName(p.unit)}`, source: "price-list", ref: `${region} ${offer} ${key} (${p.asOf})` });
    return usd;
  }

  done(e: {
    basis: EstimateBasis;
    formula: string;
    monthlyUsd?: number;
    upperBound?: boolean;
    range?: { lowUsd: number; highUsd: number };
    perUnit?: { usd: number; per: string };
    calibration?: CostEstimate["calibration"];
    summary?: string;
  }): CostEstimate {
    const summary =
      e.summary ??
      (e.monthlyUsd !== undefined
        ? `${e.upperBound ? "up to" : "≈"} ${fmtUsd(e.monthlyUsd, { sign: true })}/month`
        : e.perUnit
          ? `≈ ${fmtUsd(e.perUnit.usd, { sign: true })} per ${e.perUnit.per}`
          : "unknown from the diff");
    const range = e.range ?? (e.upperBound && e.monthlyUsd !== undefined ? { lowUsd: 0, highUsd: e.monthlyUsd } : undefined);
    return {
      basis: e.basis,
      monthlyUsd: e.monthlyUsd,
      range,
      perUnit: e.perUnit,
      formula: e.formula,
      inputs: this.inputs,
      assumptions: this.assumptions,
      calibration: e.calibration,
      region: this.region,
      priceSource: this.ctx.prices.name,
      summary,
    };
  }
}

// ---------------------------------------------------------------- shared helpers

export interface EstimateOptions {
  /** The whole file patch the finding came from: region, engine and memory settings often sit outside the snippet. */
  patch?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The cost-allocation tag value this change most likely bills under, matched on the snippet's names and the file path. */
export function matchTag(ctx: CostContext, f: DiffFinding): string | undefined {
  const tags = [...(ctx.usage?.tagValues ?? [])].sort((a, b) => b.length - a.length);
  const word = (t: string) => new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`, "i");
  return tags.find((t) => new RegExp(`name["']?\\s*[:=]\\s*["']${escapeRe(t)}["']`, "i").test(f.snippet)) ?? tags.find((t) => word(t).test(f.file));
}

function usageRef(lines: UsageLine[], tag: string | undefined, ctx: CostContext): string {
  const types = [...new Set(lines.map((l) => l.rawUsageType))].join(", ");
  const w = ctx.usage!.window;
  return `${types}${tag ? `, app=${tag}` : ", all tags"} (${w.start} to ${w.end})`;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Applies what you actually pay vs list, from the bill, and records it. */
function applyEffectiveRatio(c: Calc, lines: UsageLine[]): number {
  const r = effectiveRatio(lines);
  if (r !== 1) {
    const tags = [...new Set(lines.map((l) => l.tagValue))];
    c.inputs.push({ label: "your effective rate vs list (bill ÷ list price for this usage)", value: Number(r.toFixed(3)), unit: "×", source: "usage", ref: usageRef(lines, tags.length === 1 && tags[0] ? tags[0] : undefined, c.ctx) });
    c.assumptions.push(`New usage gets the same ${r < 1 ? "discount" : "premium"} as today's (${pct(Math.abs(1 - r))} ${r < 1 ? "below" : "above"} list), e.g. from Savings Plans or RIs.`);
  }
  return r;
}

const ratioTerm = (r: number) => (r === 1 ? "" : ` × ${r.toFixed(2)} effective rate`);

// ---------------------------------------------------------------- estimators

type Estimator = (f: DiffFinding, ctx: CostContext, patch: string) => CostEstimate;

const RDS_ENGINE_RE = /\bengine["']?\s*[:=]\s*["']?(aurora-postgresql|aurora-mysql|postgres|mysql|mariadb)/i;
const MULTI_AZ_RE = /\bmulti_?az["']?\s*[:=]\s*["']?true|MultiAZ["']?\s*:\s*["']?true/i;
const SIZES = ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge", "32xlarge", "48xlarge"];

function rdsKey(c: Calc, cls: string, patch: string): string {
  const engineMatch = patch.match(RDS_ENGINE_RE)?.[1]?.toLowerCase();
  const engine = engineMatch ? c.diff("database engine", engineMatch) : c.assume("rdsEngine", "database engine");
  const multiAz = MULTI_AZ_RE.test(patch);
  if (multiAz) c.diff("deployment", "Multi-AZ");
  return `${multiAz ? "Multi-AZUsage" : "InstanceUsage"}:${cls}@${engine}`;
}

/** Instance type or class one size up in the same family that has a price. */
function nextSizeUp(c: Calc, offer: string, key: string, region: string): string | undefined {
  const m = key.match(/^(.*\.)([a-z0-9]+)(@.*)?$/);
  if (!m) return undefined;
  const i = SIZES.indexOf(m[2]!);
  for (const size of SIZES.slice(i + 1)) {
    const k = `${m[1]}${size}${m[3] ?? ""}`;
    if (c.ctx.prices.price(region, offer, k)) return k;
  }
  return undefined;
}

const computeSize: Estimator = (f, ctx, patch) => {
  const c = new Calc(ctx, regionInDiff(patch) ?? ctx.region);
  if (regionInDiff(patch)) c.diff("region", c.region);
  const sizes = changedValues(f.snippet, SIZE_KEYS);
  if (!sizes) return c.done({ basis: "qualitative", formula: "instance size changed", summary: f.costRatio ? `${f.costRatio}x the instance price` : "unknown from the diff" });
  const rds = f.services[0] === "RDS";
  const offer = rds ? "AmazonRDS" : "AmazonEC2";
  const keyFor = (t: string) => (rds ? rdsKey(c, t, patch) : `BoxUsage:${t}`);
  const fromKey = keyFor(sizes.from);
  const toKey = rds ? fromKey.replace(sizes.from, sizes.to) : keyFor(sizes.to);
  c.diff("instance type before → after", `${sizes.from} → ${sizes.to}`, undefined, `${f.file}:${f.line ?? ""}`);
  const listFrom = c.price(offer, fromKey, `${sizes.from} on-demand price`);
  const listTo = c.price(offer, toKey, `${sizes.to} on-demand price`);
  if (listFrom === undefined && listTo === undefined) {
    return c.done({ basis: "qualitative", formula: "no price for either instance type", summary: f.costRatio ? `${f.costRatio}x the instance price` : "unknown price" });
  }
  const sizeRatio = f.costRatio ?? 1;
  if (listFrom === undefined || listTo === undefined) {
    c.assumptions.push(`No price for ${listFrom === undefined ? sizes.from : sizes.to}; scaled the other by size (${sizeRatio}x).`);
  }
  const pFrom = listFrom ?? listTo! / sizeRatio;
  const pTo = listTo ?? listFrom! * sizeRatio;

  const countInDiff = instanceCountIn(f.snippet, patch);
  const count = countInDiff ? c.diff(`instances (${countInDiff.key})`, countInDiff.count, "instances") : c.assume("instanceCount", "instances", "instances");
  const delta = pTo - pFrom;
  const diffOnly = count * delta * HOURS_PER_MONTH;
  const diffFormula = `${count} × (${fmtRate(pTo)} − ${fmtRate(pFrom)})/h × ${HOURS_PER_MONTH} h`;

  // Calibrate against the bill: how many of these instances actually run.
  const tag = matchTag(ctx, f);
  const usageType = rds ? new RegExp(`^(InstanceUsage|Multi-AZUsage):${escapeRe(sizes.from).replace("xlarge", "(xlarge|xl)")}$`) : fromKey;
  const lines = findLines(ctx.usage, { usageType, region: c.region, tag });
  const hours = sumLines(lines).quantity;
  if (hours > 0) {
    const fleet = c.usage(`${sizes.from} instances running on average`, hours / HOURS_PER_MONTH, "instances", usageRef(lines, tag, ctx));
    const ratio = applyEffectiveRatio(c, lines);
    const calibrated = fleet * delta * HOURS_PER_MONTH * ratio;
    const formula = `${fmtQty(fleet)} instances (from your bill) × (${fmtRate(pTo)} − ${fmtRate(pFrom)})/h × ${HOURS_PER_MONTH} h${ratioTerm(ratio)}`;
    if (!tag) {
      c.assumptions.push(`Couldn't tell which cost-allocation tag this resource bills under, so the bill's figure counts every ${sizes.from} in ${c.region} and is an upper bound.`);
      return c.done({
        basis: "usage-calibrated",
        formula: `between ${diffFormula} and ${formula}`,
        monthlyUsd: diffOnly,
        range: { lowUsd: Math.min(diffOnly, calibrated), highUsd: Math.max(diffOnly, calibrated) },
        summary: `≈ ${fmtUsd(diffOnly, { sign: true })} to ${fmtUsd(calibrated, { sign: true })}/month`,
      });
    }
    const drift = Math.abs(fleet - count) / Math.max(count, 1);
    return c.done({
      basis: "usage-calibrated",
      formula,
      monthlyUsd: calibrated,
      calibration:
        drift > 0.25
          ? {
              diffOnlyMonthlyUsd: diffOnly,
              note: `The diff sets ${count} instance${count === 1 ? "" : "s"}, but your bill shows about ${Math.round(fleet)} ${sizes.from} running on average under app=${tag} (autoscaling above the floor, or other resources sharing the tag). The bill's count is used.`,
            }
          : undefined,
    });
  }
  if (!countInDiff) c.assumptions.push("Instance count isn't in the diff; multiply by the number of instances using this type.");
  c.assumptions.push("Instances run 24/7 at on-demand prices. Reserved Instances, Savings Plans or Spot lower it.");
  return c.done({ basis: "list-price", formula: diffFormula, monthlyUsd: diffOnly });
};

const capacityIncrease: Estimator = (f, ctx, patch) => {
  const c = new Calc(ctx, regionInDiff(patch) ?? ctx.region);
  const service = f.services[0];

  if (service === "DynamoDB") {
    const vals = changedValues(f.snippet, /read_capacity|write_capacity|ReadCapacityUnits|WriteCapacityUnits/);
    if (!vals) return c.done({ basis: "qualitative", formula: "provisioned capacity changed" });
    const write = /write/i.test(f.title);
    const delta = c.diff(`provisioned ${write ? "WCU" : "RCU"} added`, Number(vals.to) - Number(vals.from), "units");
    const key = write ? "WriteCapacityUnit-Hrs" : "ReadCapacityUnit-Hrs";
    const lines = findLines(ctx.usage, { usageType: key, region: c.region });
    const volume = lines.length ? sumLines(lines).quantity : undefined;
    const price = c.price("AmazonDynamoDB", key, `${write ? "WCU" : "RCU"}-hour price`, { volume });
    if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
    c.assumptions.push("Fixed provisioned capacity, no auto scaling.");
    return c.done({ basis: "list-price", formula: `${delta} units × ${fmtRate(price)}/unit-hour × ${HOURS_PER_MONTH} h`, monthlyUsd: delta * price * HOURS_PER_MONTH });
  }

  if (service === "EC2") {
    const vals = changedValues(f.snippet, COUNT_KEYS);
    if (!vals) return c.done({ basis: "qualitative", formula: "instance count changed" });
    const extra = c.diff("instances added", Number(vals.to) - Number(vals.from), "instances", `${f.file}:${f.line ?? ""}`);
    const tag = matchTag(ctx, f);
    let type = stringIn(f.snippet, SIZE_KEYS) ?? stringIn(patch, SIZE_KEYS);
    if (type) c.diff("instance type", type);
    let lines: UsageLine[] = [];
    if (!type && tag) {
      // The tag's most-used instance type in the bill.
      lines = findLines(ctx.usage, { usageType: /^BoxUsage:/, region: c.region, tag });
      const top = lines[0];
      if (top) {
        type = top.usageType.replace("BoxUsage:", "");
        c.inputs.push({ label: `instance type (most-used under app=${tag})`, value: type, source: "usage", ref: usageRef([top], tag, ctx) });
        lines = [top];
      }
    }
    if (!type) type = c.assume("instanceType", "instance type");
    if (!lines.length) lines = findLines(ctx.usage, { usageType: `BoxUsage:${type}`, region: c.region, tag });
    const price = c.price("AmazonEC2", `BoxUsage:${type}`, `${type} on-demand price`);
    if (price === undefined) return c.done({ basis: "qualitative", formula: `no price for ${type}` });
    const ratio = applyEffectiveRatio(c, lines);
    c.assumptions.push("Added instances run 24/7.");
    return c.done({
      basis: ratio === 1 ? "list-price" : "usage-calibrated",
      formula: `${extra} × ${fmtRate(price)}/h × ${HOURS_PER_MONTH} h${ratioTerm(ratio)}`,
      monthlyUsd: extra * price * HOURS_PER_MONTH * ratio,
    });
  }

  if (service === "RDS" && /storage/i.test(f.title)) {
    const vals = changedValues(f.snippet, /allocated_storage|allocatedStorage|AllocatedStorage/);
    if (!vals) return c.done({ basis: "qualitative", formula: "storage changed" });
    const gb = c.diff("storage added", Number(vals.to) - Number(vals.from), "GB");
    const multiAz = MULTI_AZ_RE.test(patch);
    const key = multiAz ? "RDS:Multi-AZ-GP3-Storage" : "RDS:GP3-Storage";
    const price = c.price("AmazonRDS", key, `gp3 storage price${multiAz ? " (Multi-AZ)" : ""}`);
    if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
    if (!/gp3/i.test(patch)) c.assumptions.push("gp3 storage (the diff doesn't name the storage type).");
    return c.done({ basis: "list-price", formula: `${gb} GB × ${fmtRate(price)}/GB-month`, monthlyUsd: gb * price });
  }

  if (/retention/i.test(f.title)) {
    const vals = changedValues(f.snippet, /retention_in_days|retentionInDays|RetentionInDays|log_retention|logRetention/);
    if (!vals) return c.done({ basis: "qualitative", formula: "log retention changed" });
    const extraDays = c.diff("extra days kept", Number(vals.to) - Number(vals.from), "days");
    const price = c.price("AmazonCloudWatch", "Logs-Storage-ByteHrs", "log storage price");
    if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
    c.assumptions.push("Stored size equal to ingested size. CloudWatch bills compressed storage, so this is an upper bound.");
    const lines = findLines(ctx.usage, { usageType: "DataProcessing-Bytes" });
    const perGb = (extraDays / (HOURS_PER_MONTH / 24)) * price;
    if (lines.length) {
      const gb = c.usage("log data ingested a month (all log groups)", sumLines(lines).quantity, "GB/month", usageRef(lines, undefined, ctx));
      c.assumptions.push("Counts every log group in the account; this one is a share of it.");
      return c.done({ basis: "usage-calibrated", formula: `${fmtQty(gb)} GB/month × ${extraDays}/30.4 months extra × ${fmtRate(price)}/GB-month`, monthlyUsd: gb * perGb, upperBound: true });
    }
    return c.done({ basis: "per-unit", formula: `${extraDays}/30.4 months extra × ${fmtRate(price)}/GB-month`, perUnit: { usd: perGb, per: "GB/month ingested, once retention fills up" } });
  }

  return c.done({ basis: "qualitative", formula: f.title, summary: f.costRatio ? `${Number(f.costRatio.toFixed(2))}x the provisioned amount` : "unknown from the diff" });
};

const lambdaConfig: Estimator = (f, ctx, patch) => {
  const c = new Calc(ctx, regionInDiff(patch) ?? ctx.region);
  const arm = /\barm64\b/i.test(patch);
  const sfx = arm ? "-ARM" : "";
  if (arm) c.diff("architecture", "arm64");

  if (/memory/i.test(f.title)) {
    const vals = changedValues(f.snippet, /memorySize|memory_size|MemorySize|memory/);
    if (!vals) return c.done({ basis: "qualitative", formula: "memory changed" });
    const fromMb = Number(vals.from);
    const toMb = Number(vals.to);
    c.diff("memory before → after", `${fromMb} → ${toMb}`, "MB", `${f.file}:${f.line ?? ""}`);
    const deltaGb = (toMb - fromMb) / 1024;
    const tag = matchTag(ctx, f);
    const lines = findLines(ctx.usage, { usageType: `Lambda-GB-Second${sfx}`, region: c.region, tag });
    const volume = lines.length ? sumLines(findLines(ctx.usage, { usageType: `Lambda-GB-Second${sfx}`, region: c.region })).quantity : undefined;
    const price = c.price("AWSLambda", `Lambda-GB-Second${sfx}`, "compute price", { volume });
    if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
    c.assumptions.push("Duration doesn't drop with the extra memory. If the function is CPU-bound it may run faster and cost less than this.");

    const invocations = c.configured("lambdaInvocationsPerMonth", "invocations a month", "invocations");
    if (invocations !== undefined) {
      const sec = c.configured("lambdaDurationSeconds", "average duration", "s") ?? c.assume("scheduledRunSeconds", "average duration", "s");
      return c.done({
        basis: "list-price",
        formula: `${fmtQty(invocations)} invocations × ${sec} s × ${deltaGb.toFixed(3)} GB more × ${fmtRate(price)}/GB-s`,
        monthlyUsd: invocations * sec * deltaGb * price,
      });
    }
    if (lines.length && fromMb > 0) {
      const gbs = c.usage(`Lambda GB-seconds a month${tag ? ` under app=${tag}` : ""}`, sumLines(lines).quantity, "GB-s/month", usageRef(lines, tag, ctx));
      const ratio = applyEffectiveRatio(c, lines);
      c.assumptions.push(`Upper bound: assumes all of that Lambda usage is this function. If it's a fraction of it, scale the figure by that fraction.`);
      return c.done({
        basis: "usage-calibrated",
        formula: `${fmtQty(gbs)} GB-s/month × (${toMb}/${fromMb} − 1) × ${fmtRate(price)}/GB-s${ratioTerm(ratio)}`,
        monthlyUsd: gbs * (toMb / fromMb - 1) * price * ratio,
        upperBound: true,
      });
    }
    const spend = ctx.serviceSpend?.Lambda;
    if (spend && fromMb > 0) {
      c.inputs.push({ label: "current Lambda spend", value: spend, unit: "$/month", source: "config", ref: "service-spend" });
      c.assumptions.push("Upper bound: assumes all of your Lambda spend is this function.");
      return c.done({ basis: "usage-calibrated", formula: `${fmtUsd(spend)}/month × (${toMb}/${fromMb} − 1)`, monthlyUsd: spend * (toMb / fromMb - 1), upperBound: true });
    }
    return c.done({
      basis: "per-unit",
      formula: `1M invocations × 1 s × ${deltaGb.toFixed(3)} GB more × ${fmtRate(price)}/GB-s`,
      perUnit: { usd: 1e6 * deltaGb * price, per: "million 1-second invocations" },
    });
  }

  if (/provisioned/i.test(f.title)) {
    const vals = changedValues(f.snippet, /provisioned\w*/);
    if (!vals) return c.done({ basis: "qualitative", formula: "provisioned concurrency changed" });
    const extra = c.diff("provisioned concurrency added", Number(vals.to) - Number(vals.from), "instances");
    const mem = numberIn(patch, /memorySize|memory_size|MemorySize/);
    const mb = mem !== null ? c.diff("function memory", mem, "MB") : c.assume("lambdaMemoryMb", "function memory", "MB");
    const price = c.price("AWSLambda", `Lambda-Provisioned-Concurrency${sfx}`, "provisioned concurrency price");
    if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
    c.assumptions.push("Billed around the clock whether or not it's used; invocation charges come on top.");
    return c.done({
      basis: "list-price",
      formula: `${extra} × ${mb / 1024} GB × ${fmtRate(price)}/GB-s × ${SECONDS_PER_MONTH.toLocaleString("en-US")} s`,
      monthlyUsd: extra * (mb / 1024) * price * SECONDS_PER_MONTH,
    });
  }

  if (/timeout/i.test(f.title)) {
    return c.done({ basis: "qualitative", formula: "no direct cost", summary: "costs more only when invocations run longer" });
  }
  return c.done({ basis: "qualitative", formula: f.title, summary: "no direct cost" });
};

const queryInLoop: Estimator = (f, ctx, patch) => {
  const c = new Calc(ctx, ctx.region);
  const limit = numberIn(f.snippet, /LIMIT/) ?? patch.match(/\bLIMIT\s+(\d+)/i)?.[1];
  const items = limit != null ? c.diff("items per request (the outer query's LIMIT)", Number(limit), "items") : c.assume("loopItems", "items per request", "items");
  const requests = c.configured("requestsPerMonth", "requests a month to this code path", "requests");

  if (f.services.includes("DynamoDB") || f.services.includes("S3")) {
    const ddb = f.services.includes("DynamoDB");
    const price = ddb ? c.price("AmazonDynamoDB", "ReadRequestUnits", "on-demand read price") : c.price("AmazonS3", "Requests-Tier2", "GET request price");
    if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
    if (ddb) c.assumptions.push("One read request unit per item (strongly consistent, up to 4 KB). Eventually consistent reads cost half.");
    if (requests !== undefined) {
      return c.done({ basis: "list-price", formula: `${fmtQty(requests)} requests × ${items} reads × ${fmtRate(price)}`, monthlyUsd: requests * items * price });
    }
    return c.done({ basis: "per-unit", formula: `1M requests × ${items} reads × ${fmtRate(price)}`, perUnit: { usd: 1e6 * items * price, per: "million requests to this code path" } });
  }

  if (f.services.includes("RDS")) {
    // RDS isn't billed per query: the cost shows up when the load needs a bigger instance.
    const tag = matchTag(ctx, f);
    const lines = findLines(ctx.usage, { usageType: /^(InstanceUsage|Multi-AZUsage):db\./, region: c.region, tag });
    const top = lines[0];
    const key = top?.priceKey?.key;
    const next = key && nextSizeUp(c, "AmazonRDS", key, c.region);
    if (top && key && next) {
      const fleet = c.usage(`${key.split(":")[1]!.split("@")[0]} instances running${tag ? ` under app=${tag}` : ""}`, top.monthlyQuantity / HOURS_PER_MONTH, "instances", usageRef([top], tag, ctx));
      const pNow = c.price("AmazonRDS", key, "current instance price");
      const pNext = c.price("AmazonRDS", next, `next size up (${next.split(":")[1]!.split("@")[0]}) price`);
      if (pNow !== undefined && pNext !== undefined) {
        const ratio = applyEffectiveRatio(c, [top]);
        c.assumptions.push(`${items} queries per request instead of 1. RDS isn't billed per query: this is the cost if the extra load forces the next instance size up.`);
        return c.done({
          basis: "usage-calibrated",
          formula: `${fmtQty(fleet)} × (${fmtRate(pNext)} − ${fmtRate(pNow)})/h × ${HOURS_PER_MONTH} h${ratioTerm(ratio)}`,
          monthlyUsd: fleet * (pNext - pNow) * HOURS_PER_MONTH * ratio,
          upperBound: true,
          summary: `up to ${fmtUsd(fleet * (pNext - pNow) * HOURS_PER_MONTH * ratio, { sign: true })}/month if it forces the next instance size`,
        });
      }
    }
  }
  return c.done({
    basis: "qualitative",
    formula: `${items} queries per request instead of 1`,
    summary: `~${items}x more queries per request on this path`,
  });
};

const removedCache: Estimator = (f, ctx) => {
  const c = new Calc(ctx, ctx.region);
  if (!f.services.includes("DynamoDB")) {
    return c.done({ basis: "qualitative", formula: "every cache hit becomes a backend call", summary: "load scales with traffic instead of cache misses" });
  }
  const hit = c.assume("cacheHitRate", "cache hit rate before the change", "share of reads");
  const price = c.price("AmazonDynamoDB", "ReadRequestUnits", "on-demand read price");
  if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
  const tag = matchTag(ctx, f);
  const lines = findLines(ctx.usage, { usageType: "ReadRequestUnits", region: c.region, tag });
  const factor = hit / (1 - hit);
  if (lines.length) {
    const reads = c.usage(`DynamoDB reads a month${tag ? ` under app=${tag}` : ""}`, sumLines(lines).quantity, "read units/month", usageRef(lines, tag, ctx));
    const ratio = applyEffectiveRatio(c, lines);
    c.assumptions.push(`Today's reads are the cache misses; without the cache every request reads, so reads grow by hit ÷ (1 − hit) = ${factor.toFixed(1)}x. Upper bound if other code also reads under this tag.`);
    return c.done({
      basis: "usage-calibrated",
      formula: `${fmtQty(reads)} reads/month × ${hit}/(1 − ${hit}) × ${fmtRate(price)}${ratioTerm(ratio)}`,
      monthlyUsd: reads * factor * price * ratio,
      upperBound: true,
    });
  }
  const requests = c.configured("requestsPerMonth", "requests a month to this code path", "requests");
  if (requests !== undefined) return c.done({ basis: "list-price", formula: `${fmtQty(requests)} requests × ${hit} × ${fmtRate(price)}`, monthlyUsd: requests * hit * price });
  return c.done({ basis: "per-unit", formula: `1M requests × ${hit} former hits × ${fmtRate(price)}`, perUnit: { usd: 1e6 * hit * price, per: "million requests" } });
};

const scheduleFrequency: Estimator = (f, ctx, patch) => {
  const c = new Calc(ctx, regionInDiff(patch) ?? ctx.region);
  const minutes = (sign: string) =>
    f.snippet
      .split("\n")
      .filter((l) => l.startsWith(sign))
      .map((l) => scheduleIntervalMinutes(l))
      .find((m): m is number => m !== null);
  const toMin = minutes("+");
  if (toMin === undefined) return c.done({ basis: "qualitative", formula: "schedule changed" });
  const fromMin = minutes("-");
  const runs = (m: number) => (HOURS_PER_MONTH * 60) / m;
  const extraRuns = c.diff("extra runs a month", Math.round(runs(toMin) - (fromMin ? runs(fromMin) : 0)), "runs");
  if (!f.services.includes("Lambda")) {
    return c.done({ basis: "qualitative", formula: `${extraRuns} more runs a month × cost per run`, summary: f.costRatio ? `${f.costRatio.toFixed(0)}x this job's current cost` : "new recurring cost" });
  }
  const mem = numberIn(patch, /memorySize|memory_size|MemorySize/);
  const mb = mem !== null ? c.diff("function memory", mem, "MB") : c.assume("lambdaMemoryMb", "function memory", "MB");
  const sec = c.assume("scheduledRunSeconds", "duration of one run", "s");
  const pReq = c.price("AWSLambda", "Request", "request price");
  const pGbs = c.price("AWSLambda", "Lambda-GB-Second", "compute price");
  if (pReq === undefined || pGbs === undefined) return c.done({ basis: "qualitative", formula: "no price" });
  const perRun = pReq + (mb / 1024) * sec * pGbs;
  c.assumptions.push("Each run costs only its own invocation; reads and writes it makes are extra.");
  return c.done({
    basis: "list-price",
    formula: `${extraRuns.toLocaleString("en-US")} runs × (${fmtRate(pReq)} + ${mb / 1024} GB × ${sec} s × ${fmtRate(pGbs)}/GB-s)`,
    monthlyUsd: extraRuns * perRun,
  });
};

const S3_CLASSES: Record<string, string> = {
  STANDARD: "TimedStorage-ByteHrs",
  STANDARD_IA: "TimedStorage-SIA-ByteHrs",
  ONEZONE_IA: "TimedStorage-ZIA-ByteHrs",
  GLACIER_IR: "TimedStorage-GIR-ByteHrs",
  GLACIER: "TimedStorage-GlacierByteHrs",
  DEEP_ARCHIVE: "TimedStorage-GDA-ByteHrs",
};

/** Inter-region transfer price from the source region, to `dest` or (unknown) the most common rate. */
function interRegionPrice(c: Calc, source: string, dest: string | undefined): number | undefined {
  const code = dest && usageRegionCode(dest);
  if (code) return c.price("AWSDataTransfer", `${code}-AWS-Out-Bytes`, `transfer price ${source} → ${dest}`, { region: source });
  const others = c.ctx.prices
    .regions()
    .filter((r) => r !== source)
    .map((r) => c.ctx.prices.price(source, "AWSDataTransfer", `${usageRegionCode(r)}-AWS-Out-Bytes`))
    .filter((p): p is UnitPrice => !!p);
  if (!others.length) return undefined;
  const p = others.map(firstTier).sort((a, b) => a - b)[Math.floor(others.length / 2)]!;
  c.inputs.push({ label: `inter-region transfer price from ${source} (median; destination not in the diff)`, value: p, unit: "$/GB", source: "price-list", ref: `${source} AWSDataTransfer *-AWS-Out-Bytes` });
  return p;
}

const crossRegionTransfer: Estimator = (f, ctx, patch) => {
  const source = ctx.region;
  const c = new Calc(ctx, source);
  const dest = regionsInDiff(patch).find((r) => r !== source);
  if (dest) c.diff("destination region", dest);

  if (/NAT gateway/i.test(f.title)) {
    const region = regionInDiff(patch) ?? source;
    const n = numberIn(f.snippet, /count/);
    const gateways = n !== null ? c.diff("NAT gateways", n, "gateways") : 1;
    if (n === null) c.assumptions.push("One NAT gateway (the diff doesn't set a count; one per AZ is common).");
    const pHour = c.price("AmazonEC2", "NatGateway-Hours", "NAT gateway hourly price", { region });
    const pGb = c.price("AmazonEC2", "NatGateway-Bytes", "NAT data processing price", { region });
    if (pHour === undefined || pGb === undefined) return c.done({ basis: "qualitative", formula: "no price" });
    const fixed = gateways * pHour * HOURS_PER_MONTH;
    const gb = c.configured("natGbPerMonth", "GB a month through the gateway", "GB/month");
    if (gb !== undefined) {
      return c.done({ basis: "list-price", formula: `${gateways} × ${fmtRate(pHour)}/h × ${HOURS_PER_MONTH} h + ${fmtQty(gb)} GB × ${fmtRate(pGb)}/GB`, monthlyUsd: fixed + gb * pGb });
    }
    c.assumptions.push("Traffic through it isn't known from the diff: each GB adds the processing price. S3 and DynamoDB gateway endpoints avoid it for free.");
    return c.done({
      basis: "list-price",
      formula: `${gateways} × ${fmtRate(pHour)}/h × ${HOURS_PER_MONTH} h, + ${fmtRate(pGb)} per GB processed`,
      monthlyUsd: fixed,
      summary: `≈ ${fmtUsd(fixed, { sign: true })}/month + ${fmtRate(pGb)}/GB processed`,
    });
  }

  const transfer = interRegionPrice(c, source, dest);
  if (transfer === undefined) return c.done({ basis: "qualitative", formula: "no price" });

  if (/DynamoDB/i.test(f.title)) {
    const destRegion = dest ?? source;
    const pWrite = c.price("AmazonDynamoDB", "WriteRequestUnits", `write price in ${destRegion}`, { region: destRegion });
    if (pWrite === undefined) return c.done({ basis: "qualitative", formula: "no price" });
    const kb = c.assume("dynamoItemKb", "average item size", "KB");
    c.assumptions.push("Replicated writes priced like on-demand writes in the replica region.");
    const perMillion = 1e6 * pWrite + (1e6 * kb) / 1024 / 1024 * transfer;
    const lines = findLines(ctx.usage, { usageType: "WriteRequestUnits", region: source });
    if (lines.length) {
      const writes = c.usage("DynamoDB writes a month (source region)", sumLines(lines).quantity, "write units/month", usageRef(lines, undefined, ctx));
      c.assumptions.push("Counts every table's writes in the source region; only the replicated table's writes are billed again. Upper bound.");
      return c.done({
        basis: "usage-calibrated",
        formula: `${fmtQty(writes)} writes × (${fmtRate(pWrite)} + ${kb} KB × ${fmtRate(transfer)}/GB)`,
        monthlyUsd: (writes / 1e6) * perMillion,
        upperBound: true,
      });
    }
    return c.done({ basis: "per-unit", formula: `1M writes × (${fmtRate(pWrite)} + ${kb} KB × ${fmtRate(transfer)}/GB)`, perUnit: { usd: perMillion, per: "million writes" } });
  }

  // S3 replication: transfer + a second copy of storage + replication requests.
  const destRegion = dest ?? source;
  const cls = (stringIn(f.snippet, /storage_class|StorageClass/) ?? stringIn(patch, /storage_class|StorageClass/) ?? "STANDARD").toUpperCase();
  const classKey = S3_CLASSES[cls] ?? S3_CLASSES.STANDARD!;
  c.diff("replica storage class", cls);
  const pStore = c.price("AmazonS3", classKey, `${cls} storage price in ${destRegion}`, { region: destRegion });
  const pPut = c.price("AmazonS3", "Requests-Tier1", `PUT price in ${destRegion}`, { region: destRegion });
  if (pStore === undefined || pPut === undefined) return c.done({ basis: "qualitative", formula: "no price" });
  const perGb = transfer + pStore;
  const configured = c.configured("replicatedGbPerMonth", "GB written a month to the replicated bucket", "GB/month");
  const ingress = findLines(ctx.usage, { usageType: "DataTransfer-In-Bytes", service: "S3", region: source });
  const puts = findLines(ctx.usage, { usageType: "Requests-Tier1", service: "S3", region: source });
  const gb = configured ?? (ingress.length ? c.usage("GB written to S3 a month (data in)", sumLines(ingress).quantity, "GB/month", usageRef(ingress, undefined, ctx)) : undefined);
  if (gb === undefined) {
    c.assumptions.push("Replica storage adds up: each month's data is stored again every month after.");
    return c.done({ basis: "per-unit", formula: `1 TB × (${fmtRate(transfer)}/GB transfer + ${fmtRate(pStore)}/GB-month replica storage)`, perUnit: { usd: 1024 * perGb, per: "TB written (first month; storage then repeats monthly)" } });
  }
  const putCount = puts.length ? c.usage("objects written a month (PUT requests)", sumLines(puts).quantity, "requests/month", usageRef(puts, undefined, ctx)) : 0;
  if (configured === undefined) c.assumptions.push("Every object written to S3 in this region is in the replicated bucket. Upper bound when other buckets take writes too.");
  c.assumptions.push("First month shown. Replica storage adds up: each month's data is stored again every month after.");
  const monthly = gb * transfer + gb * pStore + putCount * pPut;
  return c.done({
    basis: "usage-calibrated",
    formula: `${fmtQty(gb)} GB × ${fmtRate(transfer)}/GB transfer + ${fmtQty(gb)} GB × ${fmtRate(pStore)}/GB-month replica + ${fmtQty(putCount)} PUTs × ${fmtRate(pPut)}`,
    monthlyUsd: monthly,
    upperBound: configured === undefined,
  });
};

const s3LifecycleRemoved: Estimator = (f, ctx) => {
  const c = new Calc(ctx, ctx.region);
  const price = c.price("AmazonS3", "TimedStorage-ByteHrs", "STANDARD storage price");
  if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
  c.assumptions.push("Objects that used to expire stay in STANDARD; the cost grows every month they're kept.");
  const ingress = findLines(ctx.usage, { usageType: "DataTransfer-In-Bytes", service: "S3", region: c.region });
  if (ingress.length) {
    const gb = c.usage("GB written to S3 a month (data in)", sumLines(ingress).quantity, "GB/month", usageRef(ingress, undefined, ctx));
    c.assumptions.push("Every object written in this region would have expired. Upper bound when the rule covered only some of them.");
    return c.done({
      basis: "usage-calibrated",
      formula: `${fmtQty(gb)} GB/month kept × ${fmtRate(price)}/GB-month, adding up each month`,
      monthlyUsd: gb * price,
      upperBound: true,
      summary: `up to ${fmtUsd(gb * price, { sign: true })}/month more every month`,
    });
  }
  return c.done({ basis: "per-unit", formula: `1 TB × ${fmtRate(price)}/GB-month`, perUnit: { usd: 1024 * price, per: "TB a month that no longer expires (adds up monthly)" } });
};

const hotPathLogging: Estimator = (f, ctx) => {
  const c = new Calc(ctx, ctx.region);
  const price = c.price("AmazonCloudWatch", "Logs-Ingestion-Bytes", "log ingestion price");
  if (price === undefined) return c.done({ basis: "qualitative", formula: "no price" });
  if (/debug/i.test(f.title)) {
    const lines = findLines(ctx.usage, { usageType: "DataProcessing-Bytes" });
    if (lines.length) {
      const gb = c.usage("log data ingested a month", sumLines(lines).quantity, "GB/month", usageRef(lines, undefined, ctx));
      c.assumptions.push("Debug logging doubles this service's volume; counts every log group, so it's an upper bound.");
      return c.done({ basis: "usage-calibrated", formula: `${fmtQty(gb)} GB/month × ${fmtRate(price)}/GB`, monthlyUsd: gb * price, upperBound: true });
    }
    return c.done({ basis: "per-unit", formula: `${fmtRate(price)}/GB ingested`, perUnit: { usd: price, per: "GB of extra log data" } });
  }
  const bytes = c.assume("logLineBytes", "size of one log line", "bytes");
  const gbPerMillionDaily = (1e6 * bytes * (HOURS_PER_MONTH / 24)) / 1024 ** 3;
  return c.done({
    basis: "per-unit",
    formula: `1M lines/day × 30.4 days × ${bytes} B × ${fmtRate(price)}/GB`,
    perUnit: { usd: gbPerMillionDaily * price, per: "million loop iterations a day" },
  });
};

const removedBatching: Estimator = (_f, ctx) =>
  new Calc(ctx, ctx.region).done({ basis: "qualitative", formula: "reads scale with data size instead of page size", summary: "grows with data size" });

const ESTIMATORS: Record<DiffFinding["detector"], Estimator> = {
  "compute-size": computeSize,
  "capacity-increase": capacityIncrease,
  "lambda-config": lambdaConfig,
  "query-in-loop": queryInLoop,
  "removed-cache": removedCache,
  "schedule-frequency": scheduleFrequency,
  "cross-region-transfer": crossRegionTransfer,
  "s3-lifecycle-removed": s3LifecycleRemoved,
  "hot-path-logging": hotPathLogging,
  "removed-batching": removedBatching,
};

/** Prices one diff finding: formula, labeled inputs, assumptions and a headline figure. */
export function estimateCost(f: DiffFinding, ctx: CostContext, options: EstimateOptions = {}): CostEstimate {
  return ESTIMATORS[f.detector](f, ctx, options.patch ?? f.snippet);
}

// ---------------------------------------------------------------- display helpers

export const INPUT_SOURCE_LABELS: Record<EstimateInput["source"], string> = {
  diff: "this change",
  usage: "your bill",
  "price-list": "AWS price list",
  config: "your config",
  default: "CommitCost default",
};

/** An input's value with its unit, e.g. "$0.384/hour", "32 instances", "m5.xlarge → m5.2xlarge". */
export function formatInputValue(i: EstimateInput): string {
  if (typeof i.value === "string") return i.unit ? `${i.value} ${i.unit}` : i.value;
  if (i.unit?.startsWith("$/")) return `${fmtRate(i.value)}/${i.unit.slice(2)}`;
  if (i.unit === "$/month") return `${fmtUsd(i.value)}/month`;
  if (i.unit === "×") return `${i.value}×`;
  return i.unit ? `${fmtQty(i.value)} ${i.unit}` : fmtQty(i.value);
}

export const BASIS_LABELS: Record<CostEstimate["basis"], string> = {
  "list-price": "list prices × values in the diff",
  "usage-calibrated": "calibrated with your bill",
  "per-unit": "price per unit of traffic",
  qualitative: "direction only",
};
