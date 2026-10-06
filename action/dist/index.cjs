"use strict";

// src/main.ts
var import_node_fs = require("node:fs");

// src/github.ts
var GitHub = class {
  constructor(token, fetchImpl = globalThis.fetch, api = "https://api.github.com") {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.api = api;
  }
  token;
  fetchImpl;
  api;
  async call(method, url, body) {
    const res = await this.fetchImpl(url.startsWith("http") ? url : `${this.api}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "commitcost-action",
        ...body ? { "Content-Type": "application/json" } : {}
      },
      body: body ? JSON.stringify(body) : void 0
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw Object.assign(new Error(`GitHub ${method} ${url.replace(this.api, "")} failed with ${res.status}: ${detail.slice(0, 200)}`), { status: res.status });
    }
    const next = res.headers.get("link")?.match(/<([^>]+)>\s*;\s*rel="next"/)?.[1] ?? null;
    return { data: await res.json(), next };
  }
  async all(path) {
    const out = [];
    let url = path;
    while (url) {
      const page = await this.call("GET", url);
      out.push(...page.data);
      url = page.next;
    }
    return out;
  }
  listPrFiles(repo, pr) {
    return this.all(`/repos/${repo}/pulls/${pr}/files?per_page=100`);
  }
  listComments(repo, pr) {
    return this.all(`/repos/${repo}/issues/${pr}/comments?per_page=100`);
  }
  async createComment(repo, pr, body) {
    await this.call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  }
  async updateComment(repo, id, body) {
    await this.call("PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
  }
};

// ../engine/src/diff/calls.ts
var PATTERNS = [
  {
    re: /\b(GetItemCommand|PutItemCommand|UpdateItemCommand|DeleteItemCommand|QueryCommand|ScanCommand|BatchGetItemCommand|GetCommand|PutCommand|UpdateCommand)\b|\bdynamo\w*\.(get|put|query|scan|update|send|get_item|put_item)\b|\bddb\w*\.(send|get|put|query|scan)\b|\.(getItem|putItem|updateItem|get_item|put_item)\s*\(/i,
    call: { services: ["DynamoDB"], kind: "dynamodb", label: "DynamoDB request" }
  },
  {
    re: /\b(GetObjectCommand|PutObjectCommand|HeadObjectCommand|CopyObjectCommand|ListObjectsV2Command)\b|\bs3\w*\.(getObject|putObject|upload|send|get_object|put_object|list_objects)\b/i,
    call: { services: ["S3"], kind: "s3", label: "S3 request" }
  },
  {
    re: /\b(InvokeCommand)\b|\blambda\w*\.invoke\b/i,
    call: { services: ["Lambda"], kind: "lambda", label: "Lambda invocation" }
  },
  {
    re: /\b(db|pool|client|conn|connection|knex|sequelize|prisma|tx|trx|orm|em|entityManager|cursor|session|sql)\b[\w.]*\.(query|execute|raw|find\w*|select|insert|update|delete|count|aggregate|first)\s*[(`]|\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\.objects\.(get|filter|all)\(|\bprisma\.\w+\.\w+\(|\bRepository\.\w+\(|\brepo\w*\.(find\w*|get|query|load)\w*\(/i,
    call: { services: ["RDS"], kind: "sql", label: "database query" }
  },
  {
    re: /\bfetch\(|\baxios(\.\w+)?\(|\bgot\(|\bhttps?\.(get|request)\(|\brequests\.(get|post|put)\(|\bhttpx\.\w+\(/,
    call: { services: [], kind: "http", label: "HTTP request" }
  }
];
function classifyDataCall(text) {
  if (/^\s*(\/\/|#|\*)/.test(text)) return null;
  for (const p of PATTERNS) if (p.re.test(text)) return p.call;
  return null;
}

// ../engine/src/diff/parse.ts
var HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
function parsePatch(patch) {
  if (!patch) return [];
  const hunks = [];
  let current;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const m = raw.match(HUNK_RE);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      current = { header: m[3].trim(), lines: [] };
      hunks.push(current);
      continue;
    }
    if (raw.startsWith("\\")) continue;
    if (!current) {
      current = { header: "", lines: [] };
      hunks.push(current);
      oldLine = newLine = 1;
    }
    if (raw.startsWith("+")) current.lines.push({ kind: "add", text: raw.slice(1), newLine: newLine++ });
    else if (raw.startsWith("-")) current.lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++ });
    else current.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldLine: oldLine++, newLine: newLine++ });
  }
  return hunks;
}
function indentOf(text) {
  const m = text.match(/^[ \t]*/)[0];
  return m.replace(/\t/g, "  ").length;
}
function newSide(hunk) {
  return hunk.lines.filter((l) => l.kind !== "del");
}
function oldSide(hunk) {
  return hunk.lines.filter((l) => l.kind !== "add");
}

// ../engine/src/diff/loops.ts
var LOOP_RE = /^\s*(for|while)\b|\bfor\s*\(|\bwhile\s*\(|\bfor\s+await\b|\.(forEach|map|flatMap|filter|reduce|each|times)\s*\(\s*(async\s*)?(\(|\w+\s*=>|function|\{|\|)|^\s*for\s+.+\s+in\s+.+:\s*$|\bdo\s*\{/;
function isLoopHeader(text) {
  if (/^\s*(\/\/|#|\*)/.test(text)) return false;
  return LOOP_RE.test(text);
}
function findLoops(lines) {
  const loops = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!isLoopHeader(header.text)) continue;
    const h = indentOf(header.text);
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.text.trim() === "") continue;
      if (indentOf(l.text) <= h) break;
      body.push(l);
    }
    if (body.length) loops.push({ header, body });
  }
  return loops;
}

// ../engine/src/diff/detectors.ts
var IAC_FILE = /\.(tf|tfvars|hcl|ya?ml|json)$|(cdk|stack|construct)\w*\.(ts|js|py)$|cloudformation|serverless/i;
var LAMBDA_FILE = /serverless\.ya?ml|template\.ya?ml|\bsam\b|lambda|functions?\.(tf|ya?ml|ts|js)/i;
var LOG_RE = /\bconsole\.(log|info|debug|warn)\(|\blogger\.(info|debug|log|trace|warn)\(|\blog\.(info|debug|Printf|Println|Info|Debug)\(|^\s*print\(|\blogging\.(info|debug|warning)\(/;
function snippetAround(lines, target, before = 3, after = 3) {
  const i = lines.indexOf(target);
  return lines.slice(Math.max(0, i - before), i + after + 1).map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`).join("\n");
}
function uniq(items) {
  return [...new Set(items)];
}
var queryInLoop = (file, hunks) => {
  const out = [];
  for (const hunk of hunks) {
    const lines = newSide(hunk);
    for (const loop of findLoops(lines)) {
      for (const line of loop.body) {
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
          title: `${call.label[0].toUpperCase()}${call.label.slice(1)} inside a loop (N+1)`,
          why: `Each iteration makes its own ${call.label}, so one request turns into one per item. On a hot path that multiplies ${call.kind === "sql" ? "database load (RDS instance and IOPS)" : call.kind === "dynamodb" ? "billed DynamoDB reads/writes" : call.kind === "s3" ? "billed S3 requests" : "request volume"}.`,
          suggestion: call.kind === "sql" ? "Fetch the related rows in one query (JOIN or WHERE id = ANY($1)) and group them in memory." : call.kind === "dynamodb" ? "Use BatchGetItem / a single Query on the partition key instead of one request per item." : "Batch the requests or move the call out of the loop.",
          snippet: snippetAround(lines, line)
        });
        break;
      }
    }
  }
  return out.filter((f, i) => out.findIndex((g) => g.line === f.line) === i);
};
var CACHE_RE = /\bcache\w*\.(get|set|del|wrap|fetch|mget)\b|\bredis\w*\.(get|set|setex|mget)\b|\bmemcache|@Cacheable|cache_page|lru_cache|@cache\b|\.setex\(|\bcached\b/i;
var removedCache = (file, hunks) => {
  const out = [];
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del" && CACHE_RE.test(l.text));
    const added = hunk.lines.filter((l) => l.kind === "add" && CACHE_RE.test(l.text));
    if (removed.length === 0 || added.length >= removed.length) continue;
    const services = uniq(hunk.lines.flatMap((l) => classifyDataCall(l.text)?.services ?? []));
    const first = removed[0];
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
      snippet: snippetAround(oldSide(hunk), first, 2, 6)
    });
  }
  return out;
};
var BATCH_RE = /\bLIMIT\s+\d+|\.limit\(|\bper_page\b|\bpageSize\b|\bpage_size\b|\bLimit:\s|\bBatch(Get|Write)\w*|\bbatch(Get|Write)\w*\(|\binsertMany\b|\bcreateMany\b|\bbulk\w*\(|\.chunk\(|\bchunk\(/;
var removedBatching = (file, hunks) => {
  const out = [];
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del" && BATCH_RE.test(l.text));
    const added = hunk.lines.filter((l) => l.kind === "add" && BATCH_RE.test(l.text));
    if (removed.length === 0 || added.length > 0) continue;
    const services = uniq(hunk.lines.flatMap((l) => classifyDataCall(l.text)?.services ?? []));
    const first = removed[0];
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
      snippet: snippetAround(oldSide(hunk), first, 2, 3)
    });
  }
  return out;
};
var KV_RE = /^\s*-?\s*["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?([^"',\s}#]+)["']?/;
function keyChanges(hunks) {
  const out = [];
  for (const hunk of hunks) {
    const removed = /* @__PURE__ */ new Map();
    for (const l of hunk.lines) {
      if (l.kind !== "del") continue;
      const m = l.text.match(KV_RE);
      if (!m) continue;
      const k = normalizeKey(m[1]);
      if (!removed.has(k)) removed.set(k, []);
      removed.get(k).push({ value: m[2], line: l });
    }
    for (const l of hunk.lines) {
      if (l.kind !== "add") continue;
      const m = l.text.match(KV_RE);
      if (!m) continue;
      const k = normalizeKey(m[1]);
      const prev = removed.get(k)?.shift();
      if (prev && prev.value !== m[2]) out.push({ key: m[1], normKey: k, from: prev.value, to: m[2], line: l, hunk });
    }
  }
  return out;
}
function normalizeKey(k) {
  return k.replace(/[-_.]/g, "").toLowerCase();
}
var SIZE_UNITS = { nano: 0.125, micro: 0.25, small: 0.5, medium: 1, large: 2, xlarge: 4, metal: 96 };
function instanceUnits(type) {
  const m = type.toLowerCase().match(/^(?:db\.|cache\.)?[a-z0-9-]+\.(nano|micro|small|medium|large|metal|(\d+)xlarge|xlarge)$/);
  if (!m) return null;
  if (m[2]) return Number(m[2]) * 4;
  return SIZE_UNITS[m[1]] ?? null;
}
var SIZE_KEYS = /* @__PURE__ */ new Set(["instancetype", "instanceclass", "dbinstanceclass", "nodetype", "cachenodetype", "instancesize"]);
var computeSize = (file) => {
  const out = [];
  for (const c of keyChanges(parsePatch(file.patch))) {
    if (!SIZE_KEYS.has(c.normKey)) continue;
    const from = instanceUnits(c.from);
    const to = instanceUnits(c.to);
    if (from === null || to === null || from === to) continue;
    const ratio = to / from;
    const rds = /^db\./i.test(c.to) || /class/.test(c.normKey) || /rds|aurora|db_instance|database/i.test(file.path);
    const service = rds ? "RDS" : "EC2";
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
      title: `${service} instance size ${c.from} \u2192 ${c.to}`,
      why: `${c.to} is ${up ? `${ratio}x the size of` : `${Math.round((1 - ratio) * 100)}% smaller than`} ${c.from}; on-demand price scales roughly with size, around the clock, for every instance using it.`,
      suggestion: up ? "Check utilisation first. If the extra capacity is only needed for a batch window, scale on a schedule instead of upsizing permanently." : "No action needed; this lowers cost.",
      snippet: snippetAround(c.hunk.lines, c.line, 4, 3),
      assumptions: "Price assumed proportional to instance size within a family (true for most current EC2/RDS families)."
    });
  }
  return out;
};
var CAPACITY_RULES = [
  { keys: ["desiredcapacity", "desiredcount", "minsize", "mincapacity", "replicas", "instancecount", "numcachenodes", "taskcount"], services: ["EC2"], label: "instance/task count", confidence: 0.8 },
  { keys: ["maxsize", "maxcapacity"], services: ["EC2"], label: "maximum instance count", confidence: 0.35 },
  { keys: ["readcapacity", "writecapacity", "readcapacityunits", "writecapacityunits"], services: ["DynamoDB"], label: "DynamoDB provisioned capacity", confidence: 0.85 },
  { keys: ["allocatedstorage", "iops", "provisionediops"], services: ["RDS"], label: "database storage/IOPS", confidence: 0.6, fileFilter: /rds|db|database|aurora/i },
  { keys: ["retentionindays", "logretention"], services: [], label: "log retention", confidence: 0.4 }
];
var LAMBDA_RULES = [
  { keys: ["memorysize"], label: "Lambda memory", confidence: 0.9, anyFile: true },
  { keys: ["memory"], label: "Lambda memory", confidence: 0.85 },
  { keys: ["provisionedconcurrency", "provisionedconcurrentexecutions"], label: "Lambda provisioned concurrency", confidence: 0.85, anyFile: true },
  { keys: ["timeout"], label: "Lambda timeout", confidence: 0.35 },
  { keys: ["reservedconcurrency", "reservedconcurrentexecutions"], label: "Lambda reserved concurrency", confidence: 0.35, anyFile: true }
];
var capacityChanges = (file) => {
  const out = [];
  for (const c of keyChanges(parsePatch(file.patch))) {
    const from = Number(c.from);
    const to = Number(c.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to || from <= 0) continue;
    const ratio = to / from;
    const up = ratio > 1;
    const snippet = snippetAround(c.hunk.lines, c.line, 4, 3);
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
        costRatio: isMemory ? ratio : void 0,
        title: `${lambda.label} ${c.from} \u2192 ${c.to}`,
        why: isMemory ? `Lambda bills memory \xD7 duration, so ${up ? `every invocation costs about ${ratio.toFixed(1)}x as much` : `each invocation costs about ${Math.round((1 - ratio) * 100)}% less`} unless the extra memory makes it proportionally faster.` : lambda.label === "Lambda timeout" ? "A longer timeout only costs more when invocations actually run that long (retries on slow dependencies, stuck loops)." : `${lambda.label} is billed whether or not it is used.`,
        suggestion: up && isMemory ? "Profile peak memory (CloudWatch REPORT lines or Lambda Power Tuning) and pick the smallest size that meets latency." : up ? "Confirm the new value is needed." : "No action needed; this lowers cost.",
        snippet,
        assumptions: isMemory ? "Assumes duration doesn't drop proportionally with the extra memory." : void 0
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
      title: `${rule.label} ${c.from} \u2192 ${c.to}`,
      why: `Provisioned ${rule.label} is billed whether or not it's used; this ${up ? `multiplies it by ${ratio.toFixed(2).replace(/\.?0+$/, "")}` : "reduces it"}.`,
      suggestion: up ? "Prefer autoscaling on load over a higher fixed floor." : "No action needed; this lowers cost.",
      snippet
    });
  }
  return out;
};
function scheduleIntervalMinutes(text) {
  const rate = text.match(/rate\(\s*(\d+)\s*(minute|hour|day)s?\s*\)/i);
  if (rate) return Number(rate[1]) * { minute: 1, hour: 60, day: 1440 }[rate[2].toLowerCase()];
  const cron = text.match(/cron\(([^)]+)\)|["']((?:[\d*/,-]+\s+){4}[\d*/,?A-Z-]+)["']/i);
  if (!cron) return null;
  const [min, hour] = (cron[1] ?? cron[2]).trim().split(/\s+/);
  const step = (f) => f === "*" ? 1 : f?.startsWith("*/") ? Number(f.slice(2)) : null;
  if (step(min) !== null) return step(min);
  if (/^\d+$/.test(min ?? "")) {
    if (step(hour) !== null) return step(hour) * 60;
    if (/^\d+$/.test(hour ?? "")) return 1440;
    if (/^[\d,]+$/.test(hour ?? "")) return 1440 / hour.split(",").length;
  }
  return null;
}
var SCHEDULE_RE = /rate\(|cron\(|schedule|["'](?:[\d*/,-]+\s+){4}[\d*/,?A-Z-]+["']/i;
var scheduleFrequency = (file, hunks) => {
  const out = [];
  const services = LAMBDA_FILE.test(file.path) ? ["Lambda"] : [];
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del" && SCHEDULE_RE.test(l.text)).map((l) => scheduleIntervalMinutes(l.text)).filter((n) => n !== null);
    for (const line of hunk.lines.filter((l) => l.kind === "add" && SCHEDULE_RE.test(l.text))) {
      const to = scheduleIntervalMinutes(line.text);
      if (to === null) continue;
      const from = removed.shift();
      if (from !== void 0 && from === to) continue;
      const faster = from !== void 0 && to < from;
      if (from !== void 0 && !faster) continue;
      out.push({
        detector: "schedule-frequency",
        file: file.path,
        line: line.newLine,
        side: "new",
        services,
        costArea: services.length ? "Lambda invocations" : "scheduled job compute",
        direction: "increase",
        confidence: faster ? 0.75 : 0.4,
        costRatio: faster ? from / to : void 0,
        title: faster ? `Schedule runs ${(from / to).toFixed(0)}x more often (every ${fmtMinutes(from)} \u2192 every ${fmtMinutes(to)})` : `New scheduled job (every ${fmtMinutes(to)})`,
        why: faster ? `The job's cost scales with how often it runs: ${Math.round(1440 / to * 30).toLocaleString()} runs a month instead of ${Math.round(1440 / from * 30).toLocaleString()}.` : `Adds ${Math.round(1440 / to * 30).toLocaleString()} runs a month, plus whatever each run reads and writes.`,
        suggestion: "Check whether the data actually changes that often; trigger on events instead of polling if possible.",
        snippet: snippetAround(newSide(hunk), line, 2, 2)
      });
    }
  }
  return out;
};
function fmtMinutes(m) {
  if (m % 1440 === 0) return m === 1440 ? "day" : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "hour" : `${m / 60} hours`;
  return m === 1 ? "minute" : `${m} minutes`;
}
var TRANSFER_PATTERNS = [
  {
    re: /aws_s3_bucket_replication_configuration|ReplicationConfiguration|replication_configuration/i,
    services: ["S3", "DataTransfer"],
    title: "S3 cross-region replication added",
    why: "Every object written is copied to another region: inter-region transfer (about $0.02/GB) plus a second copy of storage and replication requests.",
    suggestion: "Scope replication with a prefix or tag filter, and replicate into a cheaper storage class (e.g. STANDARD_IA or GLACIER_IR) if it is only for DR.",
    confidence: 0.8
  },
  {
    re: /aws_dynamodb_table_replica|global_?table|\breplica\s*\{/i,
    services: ["DynamoDB", "DataTransfer"],
    title: "DynamoDB global table replica added",
    why: "Replicated writes are billed in every replica region, plus inter-region transfer.",
    suggestion: "Confirm multi-region writes are needed; a backup/restore DR plan is much cheaper.",
    confidence: 0.75
  },
  {
    re: /aws_nat_gateway|NatGateway/i,
    services: ["DataTransfer", "EC2"],
    title: "NAT gateway added",
    why: "NAT gateways bill per hour and per GB processed; traffic to AWS services through them adds up quickly.",
    suggestion: "Add VPC endpoints (S3/DynamoDB gateway endpoints are free) so that traffic skips the NAT.",
    confidence: 0.6
  }
];
var crossRegionTransfer = (file, hunks) => {
  if (!IAC_FILE.test(file.path)) return [];
  const out = [];
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
        assumptions: "Inter-region transfer priced at about $0.02/GB (US regions)."
      });
    }
  }
  return out;
};
var LIFECYCLE_RE = /lifecycle|expiration|\btransition\b|noncurrent_version|abort_incomplete_multipart|LifecycleConfiguration/i;
var s3LifecycleRemoved = (file, hunks) => {
  if (!IAC_FILE.test(file.path)) return [];
  const out = [];
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "del" && LIFECYCLE_RE.test(l.text));
    const added = hunk.lines.filter((l) => l.kind === "add" && LIFECYCLE_RE.test(l.text));
    if (removed.length === 0 || added.length >= removed.length) continue;
    const first = removed[0];
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
      snippet: snippetAround(oldSide(hunk), first, 2, 4)
    });
  }
  return out;
};
var hotPathLogging = (file, hunks) => {
  const out = [];
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
        assumptions: "CloudWatch Logs ingestion at $0.50/GB (us-east-1)."
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
        snippet: snippetAround(newSide(hunk), debug, 1, 1)
      });
    }
  }
  return out;
};
var DETECTORS = [
  queryInLoop,
  removedCache,
  removedBatching,
  computeSize,
  capacityChanges,
  scheduleFrequency,
  crossRegionTransfer,
  s3LifecycleRemoved,
  hotPathLogging
];
function analyzeFile(file) {
  if (!file.patch) return [];
  const hunks = parsePatch(file.patch);
  return DETECTORS.flatMap((d) => d(file, hunks));
}

// ../engine/src/impact.ts
var HOURS_PER_MONTH = 730;
var EC2_PER_UNIT_HOUR = 0.048;
var RDS_PER_UNIT_HOUR = 0.076;
var LAMBDA_GB_SECOND = 166667e-10;
var LAMBDA_PROVISIONED_GB_SECOND = 41667e-10;
var DDB_RCU_MONTH = 13e-5 * HOURS_PER_MONTH;
var DDB_WCU_MONTH = 65e-5 * HOURS_PER_MONTH;
var DDB_ON_DEMAND_READ_PER_MILLION = 0.125;
var money = (n) => {
  const abs = Math.abs(n);
  const s = abs >= 100 ? Math.round(abs).toLocaleString("en-US") : abs >= 10 ? abs.toFixed(0) : abs.toFixed(2);
  return `${n < 0 ? "-" : "+"}$${s}`;
};
function numberIn(snippet, keys) {
  for (const line of snippet.split("\n")) {
    if (line.startsWith("-")) continue;
    const m = line.match(new RegExp(`\\b(?:${keys.source})["']?\\s*[:=]\\s*["']?(\\d+)`, "i"));
    if (m) return Number(m[1]);
  }
  return null;
}
function stringIn(snippet, keys) {
  for (const line of snippet.split("\n")) {
    if (line.startsWith("-")) continue;
    const m = line.match(new RegExp(`\\b(?:${keys.source})["']?\\s*[:=]\\s*["']?([\\w.-]+)`, "i"));
    if (m) return m[1];
  }
  return null;
}
function changedValues(snippet, key) {
  const lines = snippet.split("\n");
  const re = new RegExp(`\\b(?:${key.source})["']?\\s*[:=]\\s*["']?([\\w.-]+)`, "i");
  const from = lines.find((l) => l.startsWith("-") && re.test(l))?.match(re)?.[1];
  const to = lines.find((l) => l.startsWith("+") && re.test(l))?.match(re)?.[1];
  return from && to ? { from, to } : null;
}
var COUNT_KEYS = /desired_capacity|desiredCapacity|desiredCount|desired_count|min_size|minSize|replicas|instance_count|count/;
var SIZE_KEYS2 = /instance_type|instanceType|InstanceType|instance_class|instanceClass|DBInstanceClass|node_type/;
function estimateImpact(f, ctx = {}) {
  const spend = f.services.length === 1 ? ctx.serviceSpend?.[f.services[0]] : void 0;
  if (spend && f.costRatio && f.costRatio > 1 && (f.detector === "lambda-config" || f.detector === "compute-size")) {
    const upper = spend * (f.costRatio - 1);
    return {
      summary: `up to ${money(upper)}/month`,
      monthlyUsd: upper,
      assumptions: `Upper bound: assumes this resource is all of your current ${f.services[0]} spend (${money(spend).slice(1)}/month) and scales ${f.costRatio.toFixed(1)}x.`
    };
  }
  switch (f.detector) {
    case "compute-size": {
      const sizes = changedValues(f.snippet, SIZE_KEYS2);
      const from = sizes && instanceUnits(sizes.from);
      const to = sizes && instanceUnits(sizes.to);
      if (from == null || to == null) break;
      const count = numberIn(f.snippet, COUNT_KEYS) ?? 1;
      const rate = f.services[0] === "RDS" ? RDS_PER_UNIT_HOUR : EC2_PER_UNIT_HOUR;
      const monthly = (to - from) * rate * HOURS_PER_MONTH * count;
      return {
        summary: `\u2248 ${money(monthly)}/month`,
        monthlyUsd: monthly,
        assumptions: `${count} instance${count === 1 ? "" : "s"} running 24/7 at general-purpose on-demand pricing (~$${(rate * 2).toFixed(3)}/h per "large"). Reserved or Spot pricing lowers it.`
      };
    }
    case "capacity-increase": {
      if (f.services[0] === "DynamoDB" && f.costRatio) {
        const vals = changedValues(f.snippet, /read_capacity|write_capacity|ReadCapacityUnits|WriteCapacityUnits/);
        if (!vals) break;
        const write = /write/i.test(f.title);
        const monthly = (Number(vals.to) - Number(vals.from)) * (write ? DDB_WCU_MONTH : DDB_RCU_MONTH);
        return { summary: `\u2248 ${money(monthly)}/month`, monthlyUsd: monthly, assumptions: `Provisioned ${write ? "WCU" : "RCU"} at $${(write ? DDB_WCU_MONTH : DDB_RCU_MONTH).toFixed(3)} per unit-month, without auto scaling.` };
      }
      if (f.services[0] === "EC2") {
        const vals = changedValues(f.snippet, COUNT_KEYS);
        const size = stringIn(f.snippet, SIZE_KEYS2);
        const units = size ? instanceUnits(size) : null;
        if (!vals) break;
        const extra = Number(vals.to) - Number(vals.from);
        if (units != null) {
          const monthly = extra * units * EC2_PER_UNIT_HOUR * HOURS_PER_MONTH;
          return { summary: `\u2248 ${money(monthly)}/month`, monthlyUsd: monthly, assumptions: `${extra} more ${size} instance${extra === 1 ? "" : "s"} running 24/7 at on-demand pricing.` };
        }
        return { summary: `\u2248 +$70\u2013$280/month per extra instance`, assumptions: `${extra} more instances; range covers large to 2xlarge general-purpose on-demand.` };
      }
      break;
    }
    case "lambda-config": {
      if (/memory/i.test(f.title)) {
        const vals = changedValues(f.snippet, /memorySize|memory_size|MemorySize|memory/);
        if (!vals) break;
        const deltaGb = (Number(vals.to) - Number(vals.from)) / 1024;
        const perMillion = deltaGb * 1e6 * LAMBDA_GB_SECOND;
        return {
          summary: `\u2248 ${money(perMillion)} per million 1-second invocations`,
          assumptions: "Duration unchanged by the extra memory; x86 pricing. Multiply by your monthly invocations (millions) \xD7 average duration (s)."
        };
      }
      if (/provisioned/i.test(f.title)) {
        const vals = changedValues(f.snippet, /provisioned\w*/);
        if (!vals) break;
        const monthly = (Number(vals.to) - Number(vals.from)) * LAMBDA_PROVISIONED_GB_SECOND * 2628e3;
        return { summary: `\u2248 ${money(monthly)}/month per GB of function memory`, monthlyUsd: monthly, assumptions: "Provisioned concurrency billed around the clock per GB configured, before invocation charges." };
      }
      break;
    }
    case "query-in-loop": {
      if (f.services.includes("DynamoDB")) {
        const monthly = 49 * DDB_ON_DEMAND_READ_PER_MILLION;
        return {
          summary: `\u2248 ${money(monthly)}/month per million requests to this code path`,
          monthlyUsd: void 0,
          assumptions: "50 items per loop (49 extra reads per request), on-demand eventually consistent reads at $0.125 per million."
        };
      }
      return {
        summary: "~50x more queries per request on this path",
        assumptions: "A loop over 50 items makes 51 queries instead of 1\u20132. RDS isn't billed per query, so the cost shows up as a bigger instance or more read replicas once load grows."
      };
    }
    case "removed-cache":
      return {
        summary: f.services.includes("DynamoDB") ? "\u2248 +$33/month per 100 req/s of cache hits" : "load scales with traffic instead of cache misses",
        assumptions: f.services.includes("DynamoDB") ? "Each former cache hit becomes one on-demand eventually consistent read: 100 req/s \u2248 260M reads/month at $0.125 per million." : "Depends on the cache hit rate before the change."
      };
    case "schedule-frequency":
      return f.costRatio ? { summary: `${f.costRatio.toFixed(0)}x this job's current cost`, assumptions: "Each run costs about the same as before." } : { summary: "new recurring cost", assumptions: "Each run's cost is unknown from the diff." };
    case "cross-region-transfer":
      return { summary: "\u2248 +$43/month per TB written", assumptions: "$0.02/GB inter-region transfer plus a second STANDARD copy at $0.023/GB-month; replication request fees extra." };
    case "s3-lifecycle-removed":
      return { summary: "+$23/month for every TB that no longer expires, growing each month", assumptions: "S3 STANDARD at $0.023/GB-month." };
    case "hot-path-logging":
      return { summary: "\u2248 +$15/month per million iterations a day", assumptions: "1 KB per log line, CloudWatch Logs ingestion at $0.50/GB (30 GB/month)." };
    case "removed-batching":
      return { summary: "grows with data size", assumptions: "Unbounded reads scale with table size rather than page size." };
  }
  return { summary: "unknown from the diff", assumptions: "" };
}

// src/review.ts
var COMMENT_MARKER = "<!-- commitcost:pr-cost-review -->";
var DEFAULT_REVIEW_OPTIONS = { minConfidence: 0.6 };
var SKIP = /(^|\/)(node_modules|vendor|dist|build|\.next|coverage)\/|\.(min\.js|lock|snap)$|package-lock\.json$|(^|\/)(__tests__|tests?|spec|fixtures?)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$/;
function reviewFiles(files, options = {}) {
  const opts = { ...DEFAULT_REVIEW_OPTIONS, ...options };
  const ctx = { serviceSpend: opts.serviceSpend };
  return files.filter((f) => f.patch && !SKIP.test(f.path)).flatMap((f) => analyzeFile(f)).filter((f) => f.direction === "increase" && f.confidence >= opts.minConfidence).map((f) => ({ ...f, impact: estimateImpact(f, ctx) })).sort((a, b) => (b.impact.monthlyUsd ?? 0) - (a.impact.monthlyUsd ?? 0) || b.confidence - a.confidence);
}
function link(ctx, w) {
  const where = `${w.file}${w.line ? `:${w.line}` : ""}`;
  if (w.side === "old" || !w.line) return `\`${where}\``;
  return `[\`${where}\`](https://github.com/${ctx.repo}/blob/${ctx.headSha}/${w.file.split("/").map(encodeURIComponent).join("/")}#L${w.line})`;
}
var confidenceLabel = (c) => c >= 0.8 ? "high" : c >= 0.6 ? "medium" : "low";
function renderComment(warnings, ctx) {
  const short = ctx.headSha.slice(0, 7);
  if (warnings.length === 0) {
    return `${COMMENT_MARKER}
### \u2705 CommitCost: no cost risks found

The latest changes (${short}) no longer include the cost-risky patterns flagged earlier.`;
  }
  const rows = warnings.map((w, i) => `| ${i + 1} | ${w.title} | ${link(ctx, w)} | ${w.impact.summary} | ${confidenceLabel(w.confidence)} |`);
  const details = warnings.map((w, i) => {
    const lines = [
      `<details${i === 0 ? " open" : ""}><summary><b>${i + 1}. ${w.title}</b> in ${link(ctx, w)}</summary>`,
      "",
      `**Why it costs money:** ${w.why}`,
      "",
      `**Rough impact:** ${w.impact.summary}${w.impact.assumptions ? `. _Assumes: ${w.impact.assumptions}_` : ""}`,
      "",
      `**Suggested fix:** ${w.suggestion}`,
      "",
      "```diff",
      w.snippet,
      "```",
      "</details>"
    ];
    return lines.join("\n");
  });
  return [
    COMMENT_MARKER,
    `### \u{1F4B8} CommitCost: ${warnings.length} possible cost increase${warnings.length === 1 ? "" : "s"} in this PR`,
    "",
    "| # | Change | Where | Rough impact | Confidence |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    ...details,
    "",
    `<sub>Checked ${short}. Estimates are order-of-magnitude at us-east-1 on-demand prices. This comment updates on every push.</sub>`
  ].join("\n");
}

// src/run.ts
async function run(gh, input2) {
  const files = await gh.listPrFiles(input2.repo, input2.prNumber);
  const warnings = reviewFiles(
    files.filter((f) => f.status !== "removed").map((f) => ({ path: f.filename, patch: f.patch })),
    { minConfidence: input2.minConfidence, serviceSpend: input2.serviceSpend }
  );
  const body = renderComment(warnings, { repo: input2.repo, headSha: input2.headSha });
  if (input2.dryRun) return { warnings, body, action: "dry-run" };
  const existing = (await gh.listComments(input2.repo, input2.prNumber)).find((c) => c.body?.includes(COMMENT_MARKER));
  if (existing) {
    if (existing.body !== body) await gh.updateComment(input2.repo, existing.id, body);
    return { warnings, body, action: "updated" };
  }
  if (warnings.length === 0) return { warnings, body, action: "skipped-clean" };
  await gh.createComment(input2.repo, input2.prNumber, body);
  return { warnings, body, action: "created" };
}

// src/main.ts
function input(name) {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
var escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
var escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) (0, import_node_fs.appendFileSync)(process.env.GITHUB_OUTPUT, `${name}=${value}
`);
}
async function main() {
  const event = JSON.parse((0, import_node_fs.readFileSync)(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!event.pull_request) {
    console.log("Not a pull_request event; nothing to check.");
    return;
  }
  const token = input("github-token");
  if (!token) throw new Error("github-token input is empty");
  const minConfidence = Number(input("min-confidence") || 0.6);
  if (!(minConfidence >= 0 && minConfidence <= 1)) throw new Error("min-confidence must be between 0 and 1");
  const spendRaw = input("service-spend");
  const serviceSpend = spendRaw ? JSON.parse(spendRaw) : void 0;
  const result = await run(new GitHub(token, void 0, process.env.GITHUB_API_URL || void 0), {
    repo: process.env.GITHUB_REPOSITORY,
    prNumber: event.pull_request.number,
    headSha: event.pull_request.head.sha,
    minConfidence,
    serviceSpend,
    dryRun: input("dry-run") === "true"
  }).catch((err) => {
    if (err.status === 403) {
      console.warn(`::warning::Could not write the PR comment (403). For PRs from forks, the token is read-only. ${err.message}`);
      return null;
    }
    throw err;
  });
  if (!result) return;
  console.log(`CommitCost: ${result.warnings.length} cost warning(s); comment ${result.action}.`);
  for (const w of result.warnings) {
    if (w.side === "new" && w.line) console.log(`::warning file=${escapeProperty(w.file)},line=${w.line},title=${escapeProperty(w.title)}::${escapeData(`${w.why} Rough impact: ${w.impact.summary}.`)}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) (0, import_node_fs.appendFileSync)(process.env.GITHUB_STEP_SUMMARY, `${result.body}
`);
  setOutput("warnings", String(result.warnings.length));
}
main().catch((err) => {
  console.log(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
