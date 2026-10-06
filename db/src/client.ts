import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Same rule as db/scripts/env.mjs: COMMITCOST_DATABASE_URL (never the
 * generic DATABASE_URL, which other projects often set), defaulting to a
 * local SQLite file so no config is needed.
 */
export function ensureDatabaseUrl(): string {
  if (!process.env.COMMITCOST_DATABASE_URL) {
    const dir = resolve(repoRoot, ".commitcost");
    mkdirSync(dir, { recursive: true });
    process.env.COMMITCOST_DATABASE_URL = `file:${resolve(dir, "commitcost.db")}`;
  }
  return process.env.COMMITCOST_DATABASE_URL;
}

export function createClient(): PrismaClient {
  ensureDatabaseUrl();
  return new PrismaClient();
}

export type { PrismaClient };
export type { AwsConnection, GitHubInstallation, Organization, SyncRun, TrackedRepo, User } from "@prisma/client";
