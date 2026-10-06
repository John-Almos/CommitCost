import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const dbDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../db");

/** A throwaway SQLite database with the current schema. For tests only. */
export function createTestDb(): { db: PrismaClient; cleanup: () => Promise<void> } {
  const tmp = mkdtempSync(join(tmpdir(), "commitcost-platform-"));
  const url = `file:${join(tmp, "test.db")}`;
  execFileSync(process.execPath, ["scripts/prisma.mjs", "db", "push", "--skip-generate"], {
    cwd: dbDir,
    env: { ...process.env, COMMITCOST_DATABASE_URL: url },
    stdio: "pipe",
  });
  const db = new PrismaClient({ datasources: { db: { url } } });
  return {
    db,
    cleanup: async () => {
      await db.$disconnect();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
