import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Same default database as the CLI, so `npm run demo` and the dashboard share it.
if (!process.env.COMMITCOST_DATABASE_URL) {
  mkdirSync(resolve(repoRoot, ".commitcost"), { recursive: true });
  process.env.COMMITCOST_DATABASE_URL = `file:${resolve(repoRoot, ".commitcost/commitcost.db")}`;
}

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@commitcost/core", "@commitcost/db", "@commitcost/engine", "@commitcost/action", "@commitcost/platform", "@commitcost/providers"],
  serverExternalPackages: ["@prisma/client", ".prisma/client", "@aws-sdk/client-cost-explorer", "@aws-sdk/client-sts", "@anthropic-ai/sdk"],
  outputFileTracingRoot: repoRoot,
  // Workspace sources use NodeNext-style "./x.js" imports of .ts files.
  // Webpack maps those via extensionAlias; Turbopack can't yet, so the
  // scripts run Next with --webpack.
  webpack: (cfg) => {
    cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return cfg;
  },
  env: { COMMITCOST_DATABASE_URL: process.env.COMMITCOST_DATABASE_URL },
  // Don't write web/AGENTS.md on every dev start.
  agentRules: false,
};

export default config;
