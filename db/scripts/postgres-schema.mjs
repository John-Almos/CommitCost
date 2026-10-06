// Writes a Postgres copy of the schema. Only the datasource provider differs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "./env.mjs";

const src = resolve(repoRoot, "db/prisma/schema.prisma");
const outDir = resolve(repoRoot, "db/prisma/postgres");
const schema = readFileSync(src, "utf8");
const pg = schema.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
if (pg === schema) throw new Error("Could not find the sqlite datasource provider to replace");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "schema.prisma"), pg);
console.log(`Wrote ${resolve(outDir, "schema.prisma")}`);
console.log("Use it with: npx prisma generate --schema db/prisma/postgres/schema.prisma");
