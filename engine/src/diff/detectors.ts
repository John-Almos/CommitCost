import type { Service } from "@commitcost/core";
import { classifyDataCall } from "./calls.js";
import { findLoops } from "./loops.js";
import { newSide, oldSide, parsePatch, type DiffLine, type Hunk } from "./parse.js";
import type { DiffFinding, FileDiff } from "./types.js";

type Detector = (file: FileDiff, hunks: Hunk[]) => DiffFinding[];

const IAC_FILE = /\.(tf|tfvars|hcl|ya?ml|json)$|(cdk|stack|construct)\w*\.(ts|js|py)$|cloudformation|serverless/i;
const LAMBDA_FILE = /serverless\.ya?ml|template\.ya?ml|\bsam\b|lambda|functions?\.(tf|ya?ml|ts|js)/i;
const LOG_RE = /\bconsole\.(log|info|debug|warn)\(|\blogger\.(info|debug|log|trace|warn)\(|\blog\.(info|debug|Printf|Println|Info|Debug)\(|^\s*print\(|\blogging\.(info|debug|warning)\(/;

function snippetAround(lines: DiffLine[], target: DiffLine, before = 3, after = 3): string {
  const i = lines.indexOf(target);
  return lines
    .slice(Math.max(0, i - before), i + after + 1)
    .map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)
    .join("\n");
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** DB, storage or API calls inside a loop: one request per item (N+1). */
const queryInLoop: Detector = (file, hunks) => {
  const out: DiffFinding[] = [];
  for (const hunk of hunks) {
    const lines = newSide(hunk);
    for (const loop of findLoops(lines)) {
      for (const line of loop.body) {
        // Only flag what this diff introduced: the call or the loop around it.
        if (line.kind !== "add" && loop.header.kind !== "add") continue;
        const call = classifyDataCall(line.text);
        if (!call) continue;
        const area = call.kind === "http" ? "external API calls and data transfer" : `${call.services.join("/")} request volume`;
        out.push({
          detector: "query-in-loop",
          file: file.path,
          line: line.newLine,
          side: "new",
          services: call.services,
          costArea: area,
          direction: "increase",
          confidence: call.kind === "http" ? 0.6 : 0.85,
          title: `${call.label[0]!.toUpperCase()}${call.label.slice(1)} inside a loop (N+1)`,
          why: `Each iteration makes its own ${call.label}, so one request turns into one per item. On a hot path that multiplies ${call.kind === "sql" ? "database load (RDS instance and IOPS)" : call.kind === "dynamodb" ? "billed DynamoDB reads/writes" : call.kind === "s3" ? "billed S3 requests" : "request volume"}.`,
          suggestion:
            call.kind === "sql"
              ? "Fetch the related rows in one query (JOIN or WHERE id = ANY($1)) and group them in memory."
              : call.kind === "dynamodb"
                ? "Use BatchGetItem / a single Query on the partition key instead of one request per item."
                : "Batch the requests or move the call out of the loop.",
          snippet: snippetAround(lines, line),
        });
        break; // one finding per loop, even when the call spans several lines
      }
    }
  }
  // Nested loops report the same call once.
  return out.filter((f, i) => out.findIndex((g) => g.line === f.line) === i);
};

const CACHE_RE = /\bcache\w*\.(get|set|del|wrap|fetch|mget)\b|\bredis\w*\.(get|set|setex|mget)\b|\bmemcache|@Cacheable|cache_page|lru_cache|@cache\b|\.setex\(|\bcached\b/i;

/** A cache taken out from in front of a billed backend. */
const removedCache: Detector = (file, hunks) => {
  const out: DiffFinding[] = [];
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del" && CACHE_RE.test(l.text));
    const added = hunk.lines.filter((l) => l.kind === "add" && CACHE_RE.test(l.text));
    if (removed.length === 0 || added.length >= removed.length) continue;
    const services = uniq(hunk.lines.flatMap((l) => classifyDataCall(l.text)?.services ?? []));
    const first = removed[0]!;
    out.push({
      detector: "removed-cache",
      file: file.path,
      line: first.oldLine,
      side: "old",
      services,
      costArea: services.length ? `${services.join("/")} read volume` : "backend load",
      direction: "increase",
      confidence: services.length ? 0.8 : 0.55,
      title: "Cache removed in front of a backend call",
      why: `Every request that used to hit the cache now goes to ${services.length ? services.join("/") : "the backend"}. Read volume scales with traffic instead of with cache misses.`,
      suggestion: "Keep the cache and fix staleness with a shorter TTL or by invalidating on write.",
      snippet: snippetAround(oldSide(hunk), first, 2, 6),
    });
  }
  return out;
};

const BATCH_RE = /\bLIMIT\s+\d+|\.limit\(|\bper_page\b|\bpageSize\b|\bpage_size\b|\bLimit:\s|\bBatch(Get|Write)\w*|\bbatch(Get|Write)\w*\(|\binsertMany\b|\bcreateMany\b|\bbulk\w*\(|\.chunk\(|\bchunk\(/;

/** Pagination or batching taken out. */
const removedBatching: Detector = (file, hunks) => {
  const out: DiffFinding[] = [];
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del" && BATCH_RE.test(l.text));
    const added = hunk.lines.filter((l) => l.kind === "add" && BATCH_RE.test(l.text));
    if (removed.length === 0 || added.length > 0) continue;
    const services = uniq(hunk.lines.flatMap((l) => classifyDataCall(l.text)?.services ?? []));
    const first = removed[0]!;
    out.push({
      detector: "removed-batching",
      file: file.path,
      line: first.oldLine,
      side: "old",
      services,
      costArea: services.length ? `${services.join("/")} load` : "backend load",
      direction: "increase",
      confidence: services.length ? 0.6 : 0.45,
      title: "Pagination or batching removed",
      why: "Without a limit or batch, the query reads (and transfers) everything at once, or one request becomes many. Cost grows with data size.",
      suggestion: "Keep the page size / batch call, or bound the query explicitly.",
      snippet: snippetAround(oldSide(hunk), first, 2, 3),
    });
  }
  return out;
};

const KV_RE = /^\s*-?\s*["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?([^"',\s}#]+)["']?/;

interface KeyChange {
  key: string;
  normKey: string;
  from: string;
  to: string;
  line: DiffLine;
  hunk: Hunk;
}

/** Pairs `key: old` / `key: new` changes within each hunk. */
function keyChanges(hunks: Hunk[]): KeyChange[] {
  const out: KeyChange[] = [];
  for (const hunk of hunks) {
    const removed = new Map<string, { value: string; line: DiffLine }[]>();
    for (const l of hunk.lines) {
      if (l.kind !== "del") continue;
      const m = l.text.match(KV_RE);
      if (!m) continue;
      const k = normalizeKey(m[1]!);
      if (!removed.has(k)) removed.set(k, []);
      removed.get(k)!.push({ value: m[2]!, line: l });
    }
    for (const l of hunk.lines) {
      if (l.kind !== "add") continue;
      const m = l.text.match(KV_RE);
      if (!m) continue;
      const k = normalizeKey(m[1]!);
      const prev = removed.get(k)?.shift();
      if (prev && prev.value !== m[2]) out.push({ key: m[1]!, normKey: k, from: prev.value, to: m[2]!, line: l, hunk });
    }
  }
  return out;
}

function normalizeKey(k: string): string {
  return k.replace(/[-_.]/g, "").toLowerCase();
}

const SIZE_UNITS: Record<string, number> = { nano: 0.125, micro: 0.25, small: 0.5, medium: 1, large: 2, xlarge: 4, metal: 96 };

/** Relative size of an instance type, e.g. m5.2xlarge -> 8. */
export function instanceUnits(type: string): number | null {
  const m = type.toLowerCase().match(/^(?:db\.|cache\.)?[a-z0-9-]+\.(nano|micro|small|medium|large|metal|(\d+)xlarge|xlarge)$/);
  if (!m) return null;
  if (m[2]) return Number(m[2]) * 4;
  return SIZE_UNITS[m[1]!] ?? null;
}

const SIZE_KEYS = new Set(["instancetype", "instanceclass", "dbinstanceclass", "nodetype", "cachenodetype", "instancesize"]);

/** Instance / node size changes in infrastructure code. */
const computeSize: Detector = (file) => {
  const out: DiffFinding[] = [];
  for (const c of keyChanges(parsePatch(file.patch))) {
    if (!SIZE_KEYS.has(c.normKey)) continue;
    const from = instanceUnits(c.from);
    const to = instanceUnits(c.to);
    if (from === null || to === null || from === to) continue;
    const ratio = to / from;
    const rds = /^db\./i.test(c.to) || /class/.test(c.normKey) || /rds|aurora|db_instance|database/i.test(file.path);
    const service: Service = rds ? "RDS" : "EC2";
    const up = ratio > 1;
    out.push({
      detector: "compute-size",
      file: file.path,
      line: c.line.newLine,
      side: "new",
      services: [service],
      costArea: `${service} instance hours`,
      direction: up ? "increase" : "decrease",
      confidence: 0.9,
      costRatio: ratio,
      title: `${service} instance size ${c.from} → ${c.to}`,
      why: `${c.to} is ${up ? `${ratio}x the size of` : `${Math.round((1 - ratio) * 100)}% smaller than`} ${c.from}; on-demand price scales roughly with size, around the clock, for every instance using it.`,
      suggestion: up
        ? "Check utilisation first. If the extra capacity is only needed for a batch window, scale on a schedule instead of upsizing permanently."
        : "No action needed; this lowers cost.",
      snippet: snippetAround(newSide(c.hunk), c.line, 3, 2),
      assumptions: "Price assumed proportional to instance size within a family (true for most current EC2/RDS families).",
    });
  }
  return out;
};

interface CapacityRule {
  keys: string[];
  services: Service[];
  label: string;
  confidence: number;
  fileFilter?: RegExp;
}

const CAPACITY_RULES: CapacityRule[] = [
  { keys: ["desiredcapacity", "desiredcount", "minsize", "mincapacity", "replicas", "instancecount", "numcachenodes", "taskcount"], services: ["EC2"], label: "instance/task count", confidence: 0.8 },
  { keys: ["maxsize", "maxcapacity"], services: ["EC2"], label: "maximum instance count", confidence: 0.35 },
  { keys: ["readcapacity", "writecapacity", "readcapacityunits", "writecapacityunits"], services: ["DynamoDB"], label: "DynamoDB provisioned capacity", confidence: 0.85 },
  { keys: ["allocatedstorage", "iops", "provisionediops"], services: ["RDS"], label: "database storage/IOPS", confidence: 0.6, fileFilter: /rds|db|database|aurora/i },
  { keys: ["retentionindays", "logretention"], services: [], label: "log retention", confidence: 0.4 },
];

const LAMBDA_RULES: { keys: string[]; label: string; confidence: number; anyFile?: boolean }[] = [
  { keys: ["memorysize"], label: "Lambda memory", confidence: 0.9, anyFile: true },
  { keys: ["memory"], label: "Lambda memory", confidence: 0.85 },
  { keys: ["provisionedconcurrency", "provisionedconcurrentexecutions"], label: "Lambda provisioned concurrency", confidence: 0.85, anyFile: true },
  { keys: ["timeout"], label: "Lambda timeout", confidence: 0.35 },
  { keys: ["reservedconcurrency", "reservedconcurrentexecutions"], label: "Lambda reserved concurrency", confidence: 0.35, anyFile: true },
];

/** Numeric capacity knobs: counts, provisioned throughput, Lambda memory, etc. */
const capacityChanges: Detector = (file) => {
  const out: DiffFinding[] = [];
  for (const c of keyChanges(parsePatch(file.patch))) {
    const from = Number(c.from);
    const to = Number(c.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to || from <= 0) continue;
    const ratio = to / from;
    const up = ratio > 1;
    const snippet = snippetAround(newSide(c.hunk), c.line, 3, 2);

    const lambda = LAMBDA_RULES.find((r) => r.keys.includes(c.normKey) && (r.anyFile || LAMBDA_FILE.test(file.path)));
    if (lambda) {
      const isMemory = lambda.label === "Lambda memory";
      out.push({
        detector: "lambda-config",
        file: file.path,
        line: c.line.newLine,
        side: "new",
        services: ["Lambda"],
        costArea: "Lambda GB-seconds",
        direction: up ? "increase" : "decrease",
        confidence: lambda.confidence,
        costRatio: isMemory ? ratio : undefined,
        title: `${lambda.label} ${c.from} → ${c.to}`,
        why: isMemory
          ? `Lambda bills memory × duration, so ${up ? `every invocation costs about ${ratio.toFixed(1)}x as much` : `each invocation costs about ${Math.round((1 - ratio) * 100)}% less`} unless the extra memory makes it proportionally faster.`
          : lambda.label === "Lambda timeout"
            ? "A longer timeout only costs more when invocations actually run that long (retries on slow dependencies, stuck loops)."
            : `${lambda.label} is billed whether or not it is used.`,
        suggestion: up && isMemory ? "Profile peak memory (CloudWatch REPORT lines or Lambda Power Tuning) and pick the smallest size that meets latency." : up ? "Confirm the new value is needed." : "No action needed; this lowers cost.",
        snippet,
        assumptions: isMemory ? "Assumes duration doesn't drop proportionally with the extra memory." : undefined,
      });
      continue;
    }

    if (!IAC_FILE.test(file.path)) continue;
    const rule = CAPACITY_RULES.find((r) => r.keys.includes(c.normKey) && (!r.fileFilter || r.fileFilter.test(file.path)));
    if (!rule) continue;
    out.push({
      detector: "capacity-increase",
      file: file.path,
      line: c.line.newLine,
      side: "new",
      services: rule.services,
      costArea: rule.services.length ? `${rule.services.join("/")} ${rule.label}` : rule.label === "log retention" ? "CloudWatch Logs storage" : rule.label,
      direction: up ? "increase" : "decrease",
      confidence: rule.confidence,
      costRatio: ratio,
      title: `${rule.label} ${c.from} → ${c.to}`,
      why: `Provisioned ${rule.label} is billed whether or not it's used; this ${up ? `multiplies it by ${ratio.toFixed(2).replace(/\.?0+$/, "")}` : "reduces it"}.`,
      suggestion: up ? "Prefer autoscaling on load over a higher fixed floor." : "No action needed; this lowers cost.",
      snippet,
    });
  }
  return out;
};

/** Minutes between runs for rate()/cron expressions, or null if unknown. */
export function scheduleIntervalMinutes(text: string): number | null {
  const rate = text.match(/rate\(\s*(\d+)\s*(minute|hour|day)s?\s*\)/i);
  if (rate) return Number(rate[1]) * ({ minute: 1, hour: 60, day: 1440 } as const)[rate[2]!.toLowerCase() as "minute" | "hour" | "day"];
  const cron = text.match(/cron\(([^)]+)\)|["']((?:[\d*/,-]+\s+){4}[\d*/,?A-Z-]+)["']/i);
  if (!cron) return null;
  const [min, hour] = (cron[1] ?? cron[2]!).trim().split(/\s+/);
  const step = (f: string | undefined) => (f === "*" ? 1 : f?.startsWith("*/") ? Number(f.slice(2)) : null);
  if (step(min) !== null) return step(min);
  if (/^\d+$/.test(min ?? "")) {
    if (step(hour) !== null) return step(hour)! * 60;
    if (/^\d+$/.test(hour ?? "")) return 1440;
    if (/^[\d,]+$/.test(hour ?? "")) return 1440 / hour!.split(",").length;
  }
  return null;
}

const SCHEDULE_RE = /rate\(|cron\(|schedule|["'](?:[\d*/,-]+\s+){4}[\d*/,?A-Z-]+["']/i;

/** Scheduled jobs that run more often, or new ones. */
const scheduleFrequency: Detector = (file, hunks) => {
  const out: DiffFinding[] = [];
  const services: Service[] = LAMBDA_FILE.test(file.path) ? ["Lambda"] : [];
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del" && SCHEDULE_RE.test(l.text)).map((l) => scheduleIntervalMinutes(l.text)).filter((n): n is number => n !== null);
    for (const line of hunk.lines.filter((l) => l.kind === "add" && SCHEDULE_RE.test(l.text))) {
      const to = scheduleIntervalMinutes(line.text);
      if (to === null) continue;
      const from = removed.shift();
      if (from !== undefined && from === to) continue;
      const faster = from !== undefined && to < from;
      if (from !== undefined && !faster) continue;
      out.push({
        detector: "schedule-frequency",
        file: file.path,
        line: line.newLine,
        side: "new",
        services,
        costArea: services.length ? "Lambda invocations" : "scheduled job compute",
        direction: "increase",
        confidence: faster ? 0.75 : 0.4,
        costRatio: faster ? from! / to : undefined,
        title: faster ? `Schedule runs ${(from! / to).toFixed(0)}x more often (every ${fmtMinutes(from!)} → every ${fmtMinutes(to)})` : `New scheduled job (every ${fmtMinutes(to)})`,
        why: faster
          ? `The job's cost scales with how often it runs: ${Math.round((1440 / to) * 30).toLocaleString()} runs a month instead of ${Math.round((1440 / from!) * 30).toLocaleString()}.`
          : `Adds ${Math.round((1440 / to) * 30).toLocaleString()} runs a month, plus whatever each run reads and writes.`,
        suggestion: "Check whether the data actually changes that often; trigger on events instead of polling if possible.",
        snippet: snippetAround(newSide(hunk), line, 2, 2),
      });
    }
  }
  return out;
};

function fmtMinutes(m: number): string {
  if (m % 1440 === 0) return m === 1440 ? "day" : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "hour" : `${m / 60} hours`;
  return m === 1 ? "minute" : `${m} minutes`;
}

const TRANSFER_PATTERNS: { re: RegExp; services: Service[]; title: string; why: string; suggestion: string; confidence: number }[] = [
  {
    re: /aws_s3_bucket_replication_configuration|ReplicationConfiguration|replication_configuration/i,
    services: ["S3", "DataTransfer"],
    title: "S3 cross-region replication added",
    why: "Every object written is copied to another region: inter-region transfer (about $0.02/GB) plus a second copy of storage and replication requests.",
    suggestion: "Scope replication with a prefix or tag filter, and replicate into a cheaper storage class (e.g. STANDARD_IA or GLACIER_IR) if it is only for DR.",
    confidence: 0.8,
  },
  {
    re: /aws_dynamodb_table_replica|global_?table|\breplica\s*\{/i,
    services: ["DynamoDB", "DataTransfer"],
    title: "DynamoDB global table replica added",
    why: "Replicated writes are billed in every replica region, plus inter-region transfer.",
    suggestion: "Confirm multi-region writes are needed; a backup/restore DR plan is much cheaper.",
    confidence: 0.75,
  },
  {
    re: /aws_nat_gateway|NatGateway/i,
    services: ["DataTransfer", "EC2"],
    title: "NAT gateway added",
    why: "NAT gateways bill per hour and per GB processed; traffic to AWS services through them adds up quickly.",
    suggestion: "Add VPC endpoints (S3/DynamoDB gateway endpoints are free) so that traffic skips the NAT.",
    confidence: 0.6,
  },
];

/** New cross-region replication or NAT paths in infrastructure code. */
const crossRegionTransfer: Detector = (file, hunks) => {
  if (!IAC_FILE.test(file.path)) return [];
  const out: DiffFinding[] = [];
  for (const hunk of hunks) {
    for (const p of TRANSFER_PATTERNS) {
      const line = hunk.lines.find((l) => l.kind === "add" && p.re.test(l.text));
      if (!line) continue;
      out.push({
        detector: "cross-region-transfer",
        file: file.path,
        line: line.newLine,
        side: "new",
        services: p.services,
        costArea: "inter-region data transfer",
        direction: "increase",
        confidence: p.confidence,
        title: p.title,
        why: p.why,
        suggestion: p.suggestion,
        snippet: snippetAround(newSide(hunk), line, 1, 6),
        assumptions: "Inter-region transfer priced at about $0.02/GB (US regions).",
      });
    }
  }
  return out;
};

const LIFECYCLE_RE = /lifecycle|expiration|\btransition\b|noncurrent_version|abort_incomplete_multipart|LifecycleConfiguration/i;

/** S3 lifecycle rules removed: objects stop expiring or moving to cheaper storage. */
const s3LifecycleRemoved: Detector = (file, hunks) => {
  if (!IAC_FILE.test(file.path)) return [];
  const out: DiffFinding[] = [];
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del" && LIFECYCLE_RE.test(l.text));
    const added = hunk.lines.filter((l) => l.kind === "add" && LIFECYCLE_RE.test(l.text));
    if (removed.length === 0 || added.length >= removed.length) continue;
    const first = removed[0]!;
    out.push({
      detector: "s3-lifecycle-removed",
      file: file.path,
      line: first.oldLine,
      side: "old",
      services: ["S3"],
      costArea: "S3 storage",
      direction: "increase",
      confidence: 0.75,
      title: "S3 lifecycle rule removed",
      why: "Objects that used to expire or transition to cheaper storage now stay in their current class indefinitely, so storage grows every day.",
      suggestion: "Keep an expiration or transition rule for the data this bucket holds.",
      snippet: snippetAround(oldSide(hunk), first, 2, 4),
    });
  }
  return out;
};

/** Logging added inside loops: CloudWatch Logs bills ingestion per GB. */
const hotPathLogging: Detector = (file, hunks) => {
  const out: DiffFinding[] = [];
  for (const hunk of hunks) {
    const lines = newSide(hunk);
    for (const loop of findLoops(lines)) {
      const line = loop.body.find((l) => l.kind === "add" && LOG_RE.test(l.text));
      if (!line || out.some((f) => f.line === line.newLine)) continue;
      out.push({
        detector: "hot-path-logging",
        file: file.path,
        line: line.newLine,
        side: "new",
        services: [],
        costArea: "CloudWatch Logs ingestion",
        direction: "increase",
        confidence: 0.6,
        title: "Logging inside a loop",
        why: "One log line per item can mean millions of lines a day on a busy path; CloudWatch Logs charges about $0.50 per GB ingested.",
        suggestion: "Log once per batch with a count, or log at debug level and keep production at info.",
        snippet: snippetAround(lines, line),
        assumptions: "CloudWatch Logs ingestion at $0.50/GB (us-east-1).",
      });
    }
    const debug = hunk.lines.find((l) => l.kind === "add" && /LOG_LEVEL\W+["']?debug|\blevel\s*[:=]\s*["']debug/i.test(l.text));
    if (debug && !/test|spec|local|dev/i.test(file.path)) {
      out.push({
        detector: "hot-path-logging",
        file: file.path,
        line: debug.newLine,
        side: "new",
        services: [],
        costArea: "CloudWatch Logs ingestion",
        direction: "increase",
        confidence: 0.5,
        title: "Log level set to debug",
        why: "Debug logging typically multiplies log volume, and CloudWatch Logs bills per GB ingested.",
        suggestion: "Keep production at info and enable debug per request or for a limited time.",
        snippet: snippetAround(newSide(hunk), debug, 1, 1),
      });
    }
  }
  return out;
};

const DETECTORS: Detector[] = [
  queryInLoop,
  removedCache,
  removedBatching,
  computeSize,
  capacityChanges,
  scheduleFrequency,
  crossRegionTransfer,
  s3LifecycleRemoved,
  hotPathLogging,
];

/** Runs every detector on one file's patch. */
export function analyzeFile(file: FileDiff): DiffFinding[] {
  if (!file.patch) return [];
  const hunks = parsePatch(file.patch);
  return DETECTORS.flatMap((d) => d(file, hunks));
}

export function analyzeDiff(files: FileDiff[]): DiffFinding[] {
  return files.flatMap(analyzeFile);
}
