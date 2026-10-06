import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Default to a local SQLite file so mock mode needs zero configuration. */
export function ensureDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    const dir = resolve(repoRoot, ".commitcost");
    mkdirSync(dir, { recursive: true });
    process.env.DATABASE_URL = `file:${resolve(dir, "commitcost.db")}`;
  }
  return process.env.DATABASE_URL;
}
