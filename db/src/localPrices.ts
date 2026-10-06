import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Live prices fetched by `npm run sync` with COMMITCOST_PRICING=live, in the bundled snapshot's shape. */
export const LOCAL_PRICES_PATH = resolve(repoRoot, ".commitcost/prices.json");

/** The locally saved price list, or undefined when there is none (callers use the bundled snapshot). */
export function readLocalPrices<T = unknown>(path = LOCAL_PRICES_PATH): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeLocalPrices(data: unknown, path = LOCAL_PRICES_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data)}\n`);
}
