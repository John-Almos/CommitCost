// Runs the Prisma CLI against the SQLite schema with a default database URL.
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defaultDbFile, ensureDatabaseUrl, repoRoot, usingDefaultDb } from "./env.mjs";

const url = ensureDatabaseUrl();
const schema = resolve(repoRoot, "db/prisma/schema.prisma");
const args = process.argv.slice(2);

// Run the CLI's own entry with this Node rather than relying on a `prisma`
// binary being on PATH.
let cli;
try {
  cli = resolve(dirname(createRequire(import.meta.url).resolve("prisma/package.json")), "build/index.js");
} catch {
  console.error("CommitCost: the Prisma CLI isn't installed. Run `npm install` in the repo root first.");
  process.exit(1);
}

const run = (extra = []) => spawnSync(process.execPath, [cli, ...args, ...extra, "--schema", schema], { stdio: "inherit" }).status ?? 1;

let status = run();

// `db push` fails when an older local database can't be migrated in place
// (for example, a new required column on a table that has rows). The default
// local database only holds mock data and re-derivable sync results, so move
// it aside and start fresh instead of leaving the demo broken.
if (status !== 0 && args[0] === "db" && args[1] === "push" && usingDefaultDb(url) && existsSync(defaultDbFile)) {
  const backup = `${defaultDbFile}.bak-${Date.now()}`;
  renameSync(defaultDbFile, backup);
  for (const suffix of ["-journal", "-wal", "-shm"]) if (existsSync(defaultDbFile + suffix)) renameSync(defaultDbFile + suffix, backup + suffix);
  console.error(`\nCommitCost: the local database couldn't be updated to the new schema. Moved it to ${backup} and creating a fresh one.\n`);
  status = run();
}

if (status !== 0) {
  console.error(`\nCommitCost: \`prisma ${args.join(" ")}\` failed (database: ${url.startsWith("file:") ? url : "COMMITCOST_DATABASE_URL"}). The Prisma error above says why.`);
}
process.exit(status);
