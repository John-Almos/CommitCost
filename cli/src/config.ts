import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CostMetric } from "@commitcost/providers";

/** Loads .env from the repo root (if present) without overriding real env vars. */
export function loadDotEnv(root: string): void {
  const file = resolve(root, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export interface SyncConfig {
  days: number;
  github: { token: string; repo: string; branch?: string };
  aws: { tagKey?: string; metric: CostMetric; accountId?: string };
}

const METRICS: CostMetric[] = ["UnblendedCost", "AmortizedCost", "NetUnblendedCost", "NetAmortizedCost"];

/** Reads real-mode settings. Lists everything missing at once. Never echoes secret values. */
export function readSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const missing: string[] = [];
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN (a token with read access to the repo's contents and pull requests)");
  if (!env.GITHUB_REPO) missing.push("GITHUB_REPO (owner/name)");
  if (missing.length) throw new Error(`Missing configuration:\n  - ${missing.join("\n  - ")}\nSee .env.example. AWS credentials come from the standard AWS chain (AWS_PROFILE, env vars, SSO).`);

  const metric = (env.COMMITCOST_COST_METRIC ?? "UnblendedCost") as CostMetric;
  if (!METRICS.includes(metric)) throw new Error(`COMMITCOST_COST_METRIC must be one of ${METRICS.join(", ")}`);
  const days = Number(env.COMMITCOST_DAYS ?? 90);
  if (!Number.isInteger(days) || days < 21 || days > 365) throw new Error("COMMITCOST_DAYS must be a whole number between 21 and 365");

  return {
    days,
    github: { token: env.GITHUB_TOKEN!, repo: env.GITHUB_REPO!, branch: env.GITHUB_BRANCH || undefined },
    aws: { tagKey: env.COMMITCOST_TAG_KEY || undefined, metric, accountId: env.COMMITCOST_AWS_ACCOUNT_ID || undefined },
  };
}
