/**
 * GitHub Action entry point. Bundled to dist/index.cjs (run `npm run build -w
 * @commitcost/action`), so the action has no install step.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { Service } from "@commitcost/core";
import { readProfile } from "./costProfile.js";
import { GitHub } from "./github.js";
import { run } from "./run.js";

function input(name: string): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** Escaping for workflow command properties and data. */
const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function setOutput(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main(): Promise<void> {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8")) as {
    pull_request?: { number: number; head: { sha: string } };
  };
  if (!event.pull_request) {
    console.log("Not a pull_request event; nothing to check.");
    return;
  }
  const token = input("github-token");
  if (!token) throw new Error("github-token input is empty");

  const minConfidence = Number(input("min-confidence") || 0.6);
  if (!(minConfidence >= 0 && minConfidence <= 1)) throw new Error("min-confidence must be between 0 and 1");
  const spendRaw = input("service-spend");
  const serviceSpend = spendRaw ? (JSON.parse(spendRaw) as Partial<Record<Service, number>>) : undefined;
  const profile = readProfile(input("cost-profile") || undefined, {
    region: input("region") || undefined,
    assumptions: input("assumptions") || undefined,
  });
  const historyMinUsd = Number(input("history-min-usd") || 1000);

  // GITHUB_API_URL is set by Actions (and differs on GitHub Enterprise Server).
  const result = await run(new GitHub(token, undefined, process.env.GITHUB_API_URL || undefined), {
    repo: process.env.GITHUB_REPOSITORY!,
    prNumber: event.pull_request.number,
    headSha: event.pull_request.head.sha,
    minConfidence,
    serviceSpend,
    cost: profile.cost,
    calibration: profile.calibration,
    history: profile.history,
    historyMinUsd: Number.isFinite(historyMinUsd) ? historyMinUsd : 1000,
    dryRun: input("dry-run") === "true",
  }).catch((err: Error & { status?: number }) => {
    // Fork PRs get a read-only token; don't fail the build over the comment.
    if (err.status === 403) {
      console.warn(`::warning::Could not write the PR comment (403). For PRs from forks, the token is read-only. ${err.message}`);
      return null;
    }
    throw err;
  });
  if (!result) return;

  console.log(`CommitCost: ${result.warnings.length} cost warning(s), ${result.history.length} file(s) with cost history; comment ${result.action}.`);
  for (const w of result.warnings) {
    if (w.side === "new" && w.line) console.log(`::warning file=${escapeProperty(w.file)},line=${w.line},title=${escapeProperty(w.title)}::${escapeData(`${w.why} Rough impact: ${w.impact.summary}.`)}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.body}\n`);
  setOutput("warnings", String(result.warnings.length));
}

main().catch((err) => {
  console.log(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
