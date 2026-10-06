import type { DeployFile } from "@commitcost/core";
import type { Rng } from "./rng.js";

export const AUTHORS = [
  "alice-chen",
  "bmartinez",
  "dev-priya",
  "jkowalski",
  "sam-oyelaran",
  "tnguyen",
] as const;

interface FillerChange {
  title: string;
  files: DeployFile[];
}

type Template = (rng: Rng) => FillerChange;

function file(path: string, removed: string[], added: string[], context = "", startLine = 10): DeployFile {
  const header = `@@ -${startLine},${removed.length + 1} +${startLine},${added.length + 1} @@${context ? ` ${context}` : ""}`;
  const patch = [header, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
  return { path, additions: added.length, deletions: removed.length, patch };
}

const PAGES = ["checkout", "pricing", "settings", "dashboard", "signup", "billing", "team", "onboarding"];
const COMPONENTS = ["Button", "Modal", "Table", "Header", "Sidebar", "Toast", "Tabs", "DatePicker"];
const ROUTES = ["users", "invoices", "teams", "webhooks", "auth", "search", "exports", "notifications"];
const JOBS = ["sendDigest", "syncInvoices", "cleanupSessions", "rebuildSearchIndex", "expireTrials"];
const PACKAGES = ["eslint", "prettier", "vitest", "zod", "date-fns", "react-query", "pino", "undici"];
const ALARMS = ["api-5xx-rate", "worker-queue-depth", "rds-cpu", "lambda-errors", "p95-latency"];

/**
 * Benign changes that make up most of the history. Each is small and doesn't
 * move cost, which is how most real merges look.
 */
const TEMPLATES: Template[] = [
  (rng) => {
    const page = rng.pick(PAGES);
    const c = rng.pick(COMPONENTS);
    return {
      title: `Fix ${c.toLowerCase()} alignment on ${page} page`,
      files: [file(`web/src/components/${c}.tsx`, [`  <div className="${c.toLowerCase()} mt-2">`], [`  <div className="${c.toLowerCase()} mt-2 items-center">`])],
    };
  },
  (rng) => {
    const page = rng.pick(PAGES);
    return {
      title: `Update copy on ${page} page`,
      files: [file(`web/src/pages/${page}.tsx`, [`      <h1>Welcome to your ${page}</h1>`], [`      <h1>Your ${page}</h1>`])],
    };
  },
  (rng) => {
    const route = rng.pick(ROUTES);
    return {
      title: `Validate request body on ${route} endpoints`,
      files: [
        file(
          `services/api/src/routes/${route}.ts`,
          [`  const body = req.body;`],
          [`  const body = ${route}Schema.parse(req.body);`],
          `router.post("/${route}", async (req, res) => {`,
        ),
        file(`services/api/src/routes/${route}.test.ts`, [], [`  it("rejects an invalid body", async () => {`, `    await expect(post("/${route}", {})).rejects.toThrow();`, `  });`]),
      ],
    };
  },
  (rng) => {
    const route = rng.pick(ROUTES);
    return {
      title: `Add request id to ${route} error responses`,
      files: [file(`services/api/src/routes/${route}.ts`, [`    res.status(500).json({ error: "internal" });`], [`    res.status(500).json({ error: "internal", requestId: req.id });`])],
    };
  },
  (rng) => {
    const job = rng.pick(JOBS);
    return {
      title: `Retry ${job} with exponential backoff`,
      files: [
        file(
          `services/worker/src/jobs/${job}.ts`,
          [`  await run(payload);`],
          [`  await retry(() => run(payload), { retries: 3, minTimeout: 500, factor: 2 });`],
        ),
      ],
    };
  },
  (rng) => {
    const job = rng.pick(JOBS);
    return {
      title: `Add structured logging to ${job} failures`,
      files: [file(`services/worker/src/jobs/${job}.ts`, [`    console.error(err);`], [`    logger.error({ err, job: "${job}" }, "job failed");`], "} catch (err) {")],
    };
  },
  (rng) => {
    const pkg = rng.pick(PACKAGES);
    const major = rng.int(2, 9);
    return {
      title: `Bump ${pkg} to ${major}.${rng.int(0, 12)}.${rng.int(0, 9)}`,
      files: [
        file("package.json", [`    "${pkg}": "^${major - 1}.${rng.int(0, 9)}.0",`], [`    "${pkg}": "^${major}.${rng.int(0, 12)}.0",`]),
        { path: "package-lock.json", additions: rng.int(20, 300), deletions: rng.int(20, 300) },
      ],
    };
  },
  (rng) => {
    const alarm = rng.pick(ALARMS);
    return {
      title: `Add CloudWatch alarm for ${alarm}`,
      files: [
        file(
          "infra/terraform/alarms.tf",
          [],
          [`resource "aws_cloudwatch_metric_alarm" "${alarm.replace(/-/g, "_")}" {`, `  alarm_name          = "${alarm}"`, `  evaluation_periods  = 3`, `  alarm_actions       = [aws_sns_topic.oncall.arn]`, `}`],
        ),
      ],
    };
  },
  (rng) => {
    const route = rng.pick(ROUTES);
    return {
      title: `Add tests for ${route} pagination`,
      files: [file(`services/api/src/routes/${route}.test.ts`, [], [`  it("returns a next cursor when more results exist", async () => {`, `    const res = await get("/${route}?limit=2");`, `    expect(res.body.nextCursor).toBeDefined();`, `  });`])],
    };
  },
  () => ({
    title: "Tighten IAM policy for worker role",
    files: [file("infra/terraform/iam.tf", [`      actions   = ["s3:*"]`], [`      actions   = ["s3:GetObject", "s3:PutObject"]`])],
  }),
  () => ({
    title: "Cache node_modules in CI",
    files: [file(".github/workflows/ci.yml", [`      - run: npm ci`], [`      - uses: actions/setup-node@v4`, `        with:`, `          cache: npm`, `      - run: npm ci`])],
  }),
  (rng) => {
    const c = rng.pick(COMPONENTS);
    return {
      title: `Improve keyboard accessibility for ${c}`,
      files: [file(`web/src/components/${c}.tsx`, [`    <div onClick={onSelect}>`], [`    <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={onKey}>`])],
    };
  },
  (rng) => {
    const page = rng.pick(PAGES);
    return {
      title: `Fix timezone bug in ${page} date display`,
      files: [file("web/src/lib/formatDate.ts", [`  return format(new Date(value), "MMM d");`], [`  return formatInTimeZone(new Date(value), tz, "MMM d");`])],
    };
  },
  (rng) => {
    const [table, column] = rng.pick([["orders", "created_at"], ["invoices", "team_id"], ["sessions", "expires_at"], ["webhooks", "status"]] as const);
    return {
      title: `Add index on ${table}.${column}`,
      files: [file(`services/api/migrations/${rng.int(100, 999)}_${table}_${column}_idx.sql`, [], [`CREATE INDEX CONCURRENTLY ${table}_${column}_idx ON ${table} (${column});`])],
    };
  },
  (rng) => {
    const route = rng.pick(ROUTES);
    return {
      title: `Return 404 instead of 500 for missing ${route.replace(/s$/, "")}`,
      files: [file(`services/api/src/routes/${route}.ts`, [`  const row = await repo.get(id);`], [`  const row = await repo.get(id);`, `  if (!row) return res.status(404).json({ error: "not_found" });`])],
    };
  },
  () => ({
    title: "Update README with local setup steps",
    files: [file("README.md", [`Run the app with docker compose.`], [`Run \`docker compose up\`, then \`npm run dev\`.`])],
  }),
];

export function randomFillerChange(rng: Rng): FillerChange {
  return rng.pick(TEMPLATES)(rng);
}
