import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Same default as db/scripts/env.mjs: a local SQLite file, no config needed. */
export function ensureDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    const dir = resolve(repoRoot, ".commitcost");
    mkdirSync(dir, { recursive: true });
    process.env.DATABASE_URL = `file:${resolve(dir, "commitcost.db")}`;
  }
  return process.env.DATABASE_URL;
}

export function createClient(): PrismaClient {
  ensureDatabaseUrl();
  return new PrismaClient();
}

export type { PrismaClient };
