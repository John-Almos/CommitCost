// Runs the Prisma CLI against the SQLite schema with a default DATABASE_URL.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ensureDatabaseUrl, repoRoot } from "./env.mjs";

ensureDatabaseUrl();
const schema = resolve(repoRoot, "db/prisma/schema.prisma");
const result = spawnSync("prisma", [...process.argv.slice(2), "--schema", schema], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
