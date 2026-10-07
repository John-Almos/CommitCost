import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SAMPLE_PRS } from "./fixtures.js";
import { GitHub, type Fetch } from "./github.js";
import { SnapshotPriceBook, buildUsageProfile } from "@commitcost/engine";
import { readCostProfileFile } from "./costProfile.js";
import { COMMENT_MARKER, historyFor, renderComment, reviewFiles } from "./review.js";
import { run } from "./run.js";

const toDiffs = (files: readonly { filename: string; patch?: string }[]) => files.map((f) => ({ path: f.filename, patch: f.patch }));
const ctx = { repo: "acme/app", headSha: "abcdef1234567890" };

describe("reviewFiles", () => {
  it("flags a query added inside a loop and skips test files", () => {
    const warnings = reviewFiles(toDiffs(SAMPLE_PRS.nPlusOne.files));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ detector: "query-in-loop", file: "services/api/src/routes/orders.ts", line: 44 });
  });

  it("keeps confident increases, drops low-confidence ones, and sorts by estimated impact", () => {
    const warnings = reviewFiles(toDiffs(SAMPLE_PRS.infra.files));
    expect(warnings.map((w) => w.title)).toEqual(["EC2 instance size m5.xlarge → m5.2xlarge", "Lambda memory 512 → 3008"]);
    expect(warnings[0]!.impact.monthlyUsd).toBeCloseTo(420.48, 1);
    // Timeout change (0.35) is below the default threshold.
    expect(reviewFiles(toDiffs(SAMPLE_PRS.infra.files), { minConfidence: 0.3 })).toHaveLength(3);
  });

  it("returns nothing for a clean PR", () => {
    expect(reviewFiles(toDiffs(SAMPLE_PRS.clean.files))).toEqual([]);
  });

  it("bounds estimates with known service spend", () => {
    const warnings = reviewFiles(toDiffs(SAMPLE_PRS.infra.files), { serviceSpend: { Lambda: 100 } });
    // 100 * (3008/512 - 1) = 487.5, which now outranks the EC2 estimate.
    expect(warnings[0]!.detector).toBe("lambda-config");
    expect(warnings[0]!.impact.summary).toBe("up to +$488/month");
  });
});

describe("cost profile", () => {
  it("calibrates estimates with an exported usage profile and shows the working", () => {
    const usage = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      provider: "aws" as const,
      accountId: "1",
      service: "EC2" as const,
      usageType: "BoxUsage:m5.xlarge",
      tagKey: "app",
      tagValue: "worker",
      unit: "Hrs",
      quantity: 30 * 24,
      costUsd: 30 * 24 * 0.192,
      source: "aws-cost-explorer" as const,
    }));
    const dir = mkdtempSync(join(tmpdir(), "cc-profile-"));
    const path = join(dir, "profile.json");
    writeFileSync(path, JSON.stringify({ version: 1, generatedAt: "2026-09-15", region: "us-east-1", usage: buildUsageProfile(usage, new SnapshotPriceBook()) }));
    const warnings = reviewFiles(toDiffs(SAMPLE_PRS.infra.files), { cost: readCostProfileFile(path, { assumptions: '{"cacheHitRate":0.9}' }) });
    expect(warnings[0]!.impact.estimate.basis).toBe("usage-calibrated");
    expect(warnings[0]!.impact.monthlyUsd).toBeCloseTo(30 * 0.192 * 730, 1);
    const body = renderComment(warnings, ctx);
    expect(body).toContain("How this was calculated");
    expect(body).toContain("30 instances (from your bill) × ($0.384 − $0.192)/h × 730 h");
    expect(body).toContain("Volumes calibrated with your bill.");
    expect(() => readCostProfileFile(undefined, { assumptions: "{nope" })).toThrow(/assumptions must be a JSON object/);
  });
});

describe("receipts and history in the PR check", () => {
  const calibration = { "compute-size": { detector: "compute-size" as const, factor: 1.5, medianRatio: 2.25, samples: 2, from: [] } };

  it("adjusts estimates with the learned correction and says why", () => {
    const [plain] = reviewFiles(toDiffs(SAMPLE_PRS.infra.files));
    const [w] = reviewFiles(toDiffs(SAMPLE_PRS.infra.files), { calibration });
    expect(plain!.calibrated).toBeUndefined();
    expect(w!.detector).toBe("compute-size");
    expect(w!.calibrated!.monthlyUsd).toBeCloseTo(w!.impact.monthlyUsd! * 1.5);
    const body = renderComment([w!], ctx);
    expect(body).toContain("×1.50 from receipts");
    expect(body).toContain("ran 2.3× low on your bill across 2 merged PRs");
  });

  it("matches history to touched runtime files only", () => {
    const hist = [{ path: "a/x.ts", increaseUsd: 500, owners: [], changes: [] }, { path: "a/x.test.ts", increaseUsd: 900, owners: [], changes: [] }];
    expect(historyFor([{ path: "a/x.ts" }, { path: "a/x.test.ts" }, { path: "b.ts" }], hist).map((h) => h.path)).toEqual(["a/x.ts"]);
  });
});

describe("renderComment", () => {
  it("writes one sensible comment for a query in a loop", () => {
    const body = renderComment(reviewFiles(toDiffs(SAMPLE_PRS.nPlusOne.files)), ctx);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("1 possible cost increase in this PR");
    expect(body).toContain("Database query inside a loop (N+1)");
    expect(body).toContain("https://github.com/acme/app/blob/abcdef1234567890/services/api/src/routes/orders.ts#L44");
    expect(body).toMatch(/\*\*Why it costs money:\*\* Each iteration makes its own database query/);
    expect(body).toContain("**Estimated impact:** ~50x more queries per request on this path");
    expect(body).toContain("| items per request (the outer query's LIMIT) | 50 items | this change |");
    expect(body).toContain("**Suggested fix:** Fetch the related rows in one query");
    expect(body).toContain("+  for (const order of orders.rows) {");
  });

  it("says the PR is clean when earlier warnings were fixed", () => {
    expect(renderComment([], ctx)).toContain("no cost risks found");
  });
});

/** In-memory GitHub API: PR files plus issue comments, recording writes. */
function fakeGitHub(files: readonly object[], comments: { id: number; body: string }[] = []) {
  const writes: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    let body: unknown = [];
    if (path.includes("/files")) body = files;
    else if (init.method === "GET" && path.includes("/comments")) body = comments;
    else if (init.method === "POST") {
      writes.push(`POST ${path}`);
      comments.push({ id: 99, body: JSON.parse(init.body!).body });
      body = {};
    } else if (init.method === "PATCH") {
      writes.push(`PATCH ${path}`);
      comments.find((c) => path.endsWith(`/${c.id}`))!.body = JSON.parse(init.body!).body;
      body = {};
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => "" };
  };
  return { gh: new GitHub("t", fetch), writes, comments };
}

const input = { repo: "acme/app", prNumber: 5, headSha: "abc1234", minConfidence: 0.6, dryRun: false };

describe("run", () => {
  it("creates one comment, then edits it in place on the next push", async () => {
    const { gh, writes, comments } = fakeGitHub(SAMPLE_PRS.nPlusOne.files);
    expect((await run(gh, input)).action).toBe("created");
    expect((await run(gh, { ...input, headSha: "def5678" })).action).toBe("updated");
    expect(writes).toEqual(["POST /repos/acme/app/issues/5/comments", "PATCH /repos/acme/app/issues/comments/99"]);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Checked def5678");
  });

  it("never comments on a clean PR, but updates an earlier comment once fixed", async () => {
    const clean = fakeGitHub(SAMPLE_PRS.clean.files);
    expect((await run(clean.gh, input)).action).toBe("skipped-clean");
    expect(clean.writes).toEqual([]);

    const fixed = fakeGitHub(SAMPLE_PRS.clean.files, [{ id: 7, body: `${COMMENT_MARKER}\nold warnings` }]);
    expect((await run(fixed.gh, input)).action).toBe("updated");
    expect(fixed.comments[0]!.body).toContain("no cost risks found");
  });

  const history = [
    { path: "services/api/src/routes/orders.ts", increaseUsd: 2850, owners: ["@acme/api-team"], changes: [{ prNumber: 128, title: "Show line items", monthlyUsd: 2850 }] },
  ];

  it("comments on a PR with no warnings when it touches a file that raised the bill", async () => {
    const files = [{ filename: "services/api/src/routes/orders.ts", status: "modified", patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;" }];
    const quiet = fakeGitHub(files);
    expect((await run(quiet.gh, { ...input, history, historyMinUsd: 5000 })).action).toBe("skipped-clean");
    const loud = fakeGitHub(files);
    const result = await run(loud.gh, { ...input, history });
    expect(result.action).toBe("created");
    expect(result.body).toContain("this PR changes code that has raised the bill before");
    expect(result.body).toContain("| `services/api/src/routes/orders.ts` | +$2,850/month | #128 +$2,850/mo | @acme/api-team |");
  });

  it("writes nothing in dry-run mode", async () => {
    const { gh, writes } = fakeGitHub(SAMPLE_PRS.nPlusOne.files);
    expect((await run(gh, { ...input, dryRun: true })).action).toBe("dry-run");
    expect(writes).toEqual([]);
  });
});

describe("bundled action (dist/index.cjs)", () => {
  const actionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  it("is up to date with the source", () => {
    const before = readFileSync(join(actionDir, "dist/index.cjs"), "utf8");
    execFileSync("npm", ["run", "build", "--silent"], { cwd: actionDir, stdio: "pipe" });
    expect(readFileSync(join(actionDir, "dist/index.cjs"), "utf8")).toBe(before);
  });

  it("comments on a PR that adds a query inside a loop", async () => {
    const posted: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url!.includes("/files")) return res.end(JSON.stringify(SAMPLE_PRS.nPlusOne.files));
        if (req.method === "GET") return res.end("[]");
        posted.push(JSON.parse(data).body);
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    const tmp = mkdtempSync(join(tmpdir(), "cc-action-"));
    writeFileSync(join(tmp, "event.json"), JSON.stringify({ pull_request: { number: 12, head: { sha: "feedface00" } } }));
    writeFileSync(join(tmp, "out"), "");
    const env = {
      ...process.env,
      GITHUB_EVENT_PATH: join(tmp, "event.json"),
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_OUTPUT: join(tmp, "out"),
      "INPUT_GITHUB-TOKEN": "test-token",
      "INPUT_MIN-CONFIDENCE": "0.6",
    };
    const stdout = await new Promise<string>((resolveRun, reject) => {
      const child = spawn(process.execPath, [join(actionDir, "dist/index.cjs")], { env });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("exit", (code) => (code === 0 ? resolveRun(out) : reject(new Error(`exit ${code}: ${out}`))));
    });
    server.close();

    expect(stdout).toContain("1 cost warning(s), 0 file(s) with cost history; comment created.");
    expect(stdout).toContain("::warning file=services/api/src/routes/orders.ts,line=44,title=Database query inside a loop (N+1)::");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Database query inside a loop (N+1)");
    expect(readFileSync(join(tmp, "out"), "utf8")).toBe("warnings=1\n");
  }, 30_000);
});
