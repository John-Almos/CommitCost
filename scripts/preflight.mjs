// Checks the things `npm run demo` needs before anything else runs, so a
// setup problem shows one clear message instead of a failed lifecycle script.
// Keep this file to syntax very old Node versions can parse.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = [20, 9];
const problems = [];

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < REQUIRED[0] || (major === REQUIRED[0] && minor < REQUIRED[1])) {
  problems.push(
    `Node ${process.versions.node} is too old. CommitCost needs Node ${REQUIRED.join(".")} or newer (22 recommended).\n` +
      "   Install it with nvm (`nvm install 22 && nvm use 22`) or from https://nodejs.org, open a new terminal,\n" +
      "   check `node -v`, then run `rm -rf node_modules && npm install` before `npm run demo`.",
  );
} else if (!existsSync(resolve(root, "node_modules/prisma/package.json")) || !existsSync(resolve(root, "node_modules/next/package.json"))) {
  problems.push("Dependencies aren't fully installed (an earlier `npm install` probably failed).\n   Run `rm -rf node_modules && npm install` and check that it finishes without errors.");
} else if (!existsSync(resolve(root, "node_modules/.prisma/client/index.js"))) {
  problems.push("The Prisma client hasn't been generated. Run `npm run db:generate` (or `npm install` again).");
}

if (problems.length) {
  console.error("\nCommitCost can't start yet:\n");
  for (const p of problems) console.error(` - ${p}\n`);
  process.exit(1);
}
