import { resolve } from "node:path";
import { addDays, toIsoDate } from "@commitcost/core";
import { latestCostDate, latestDeployDate, saveCodeowners, saveCostRecords, saveDeploys, saveUsageRecords, type PrismaClient } from "@commitcost/db";
import { writeLocalPrices } from "@commitcost/db";
import { stripRegionPrefix } from "@commitcost/engine";
import { AwsCostExplorerProvider, AwsPriceList, FileCache, GitHubProvider } from "@commitcost/providers";
import type { SyncConfig } from "./config.js";

/** Cost Explorer revises the last few days; always re-fetch them. */
const COST_OVERLAP_DAYS = 3;

/**
 * Pulls AWS costs and GitHub history into the database. Incremental after the
 * first run: only days since the last sync (plus a small overlap) are fetched,
 * and settled Cost Explorer responses are cached on disk.
 */
export async function sync(db: PrismaClient, config: SyncConfig, cacheDir: string, log = console.log) {
  const end = addDays(toIsoDate(new Date()), -1);
  const fullStart = addDays(end, -(config.days - 1));

  const lastCost = await latestCostDate(db, "aws-cost-explorer");
  const costStart = lastCost && lastCost >= fullStart ? addDays(lastCost, -COST_OVERLAP_DAYS) : fullStart;
  const aws = new AwsCostExplorerProvider({ ...config.aws, cache: new FileCache(resolve(cacheDir, "cost-explorer")) });
  log(`AWS: fetching daily costs ${costStart} → ${end}${config.aws.tagKey ? ` grouped by tag "${config.aws.tagKey}"` : ""}...`);
  const costs = await aws.getDailyCosts({ start: costStart, end });
  await saveCostRecords(db, costs);
  log(`AWS: fetching usage by usage type ${costStart} → ${end} (volumes and effective rates for the cost model)...`);
  const usage = await aws.getUsage({ start: costStart, end });
  await saveUsageRecords(db, usage);
  log(`AWS: stored ${costs.length} cost records and ${usage.length} usage records (${aws.requestCount} Cost Explorer request${aws.requestCount === 1 ? "" : "s"}, about $${(aws.requestCount * 0.01).toFixed(2)}).`);

  if (config.pricing === "live") {
    // Price the regions you actually use, from the Price List API (pricing:GetProducts).
    const regions = [...new Set(usage.map((u) => stripRegionPrefix(u.usageType).region ?? "us-east-1"))];
    const priceList = new AwsPriceList({ cache: new FileCache(resolve(cacheDir, "price-list")) });
    log(`AWS: loading list prices for ${regions.join(", ")} from the Price List API...`);
    const book = await priceList.priceBook(regions.length ? regions : ["us-east-1"]);
    writeLocalPrices(book.snapshot);
    log(`AWS: saved prices for ${regions.length} region${regions.length === 1 ? "" : "s"} (${priceList.requestCount} Price List requests, free).`);
  }

  const lastDeploy = await latestDeployDate(db, config.github.repo);
  const deployStart = lastDeploy && lastDeploy >= fullStart ? addDays(lastDeploy, -1) : fullStart;
  const github = new GitHubProvider({ ...config.github });
  log(`GitHub: fetching merged changes on ${config.github.repo} ${deployStart} → ${end}...`);
  const deploys = await github.getDeploys({ start: deployStart, end });
  await saveDeploys(db, deploys);
  const codeowners = await github.getCodeowners();
  await saveCodeowners(db, config.github.repo, codeowners);
  log(`GitHub: stored ${deploys.length} deploys${codeowners ? " and the CODEOWNERS file" : " (no CODEOWNERS file found)"} (${github.client.requestCount} API requests).`);

  return { costs: costs.length, usage: usage.length, deploys: deploys.length, start: fullStart, end };
}
