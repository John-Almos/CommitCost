import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const defaultDbFile = resolve(repoRoot, ".commitcost/commitcost.db");

/**
 * CommitCost reads COMMITCOST_DATABASE_URL, never the generic DATABASE_URL,
 * so a DATABASE_URL exported for another project (often Postgres) can't
 * point Prisma's SQLite schema at the wrong database. Defaults to a local
 * SQLite file so mock mode needs zero configuration.
 */
export function ensureDatabaseUrl() {
  const envFile = resolve(repoRoot, ".env");
  if (!process.env.COMMITCOST_DATABASE_URL && existsSync(envFile)) process.loadEnvFile?.(envFile);
  if (!process.env.COMMITCOST_DATABASE_URL) {
    mkdirSync(dirname(defaultDbFile), { recursive: true });
    process.env.COMMITCOST_DATABASE_URL = `file:${defaultDbFile}`;
  }
  return process.env.COMMITCOST_DATABASE_URL;
}

export const usingDefaultDb = (url) => url === `file:${defaultDbFile}`;
