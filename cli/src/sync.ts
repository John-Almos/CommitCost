import { resolve } from "node:path";
import { addDays, toIsoDate } from "@commitcost/core";
import { latestCostDate, latestDeployDate, saveCostRecords, saveDeploys, type PrismaClient } from "@commitcost/db";
import { AwsCostExplorerProvider, FileCache, GitHubProvider } from "@commitcost/providers";
import type { SyncConfig } from "./config.js";

/** Cost Explorer revises the last few days; always re-fetch them. */
const COST_OVERLAP_DAYS = 3;

/**
 * Self-hosted sync with local credentials: pulls AWS costs (standard AWS
 * credential chain) and GitHub history (a token) into one workspace. Hosted
 * workspaces sync through the worker instead. Incremental after the
 * first run: only days since the last sync (plus a small overlap) are fetched,
 * and settled Cost Explorer responses are cached on disk.
 */
export async function sync(db: PrismaClient, orgId: string, config: SyncConfig, cacheDir: string, log = console.log) {
  const end = addDays(toIsoDate(new Date()), -1);
  const fullStart = addDays(end, -(config.days - 1));

  const lastCost = await latestCostDate(db, orgId, "aws-cost-explorer");
  const costStart = lastCost && lastCost >= fullStart ? addDays(lastCost, -COST_OVERLAP_DAYS) : fullStart;
  const aws = new AwsCostExplorerProvider({ ...config.aws, cache: new FileCache(resolve(cacheDir, "cost-explorer")) });
  log(`AWS: fetching daily costs ${costStart} → ${end}${config.aws.tagKey ? ` grouped by tag "${config.aws.tagKey}"` : ""}...`);
  const costs = await aws.getDailyCosts({ start: costStart, end });
  await saveCostRecords(db, orgId, costs);
  log(`AWS: stored ${costs.length} cost records (${aws.requestCount} Cost Explorer request${aws.requestCount === 1 ? "" : "s"}, about $${(aws.requestCount * 0.01).toFixed(2)}).`);

  const lastDeploy = await latestDeployDate(db, orgId, config.github.repo);
  const deployStart = lastDeploy && lastDeploy >= fullStart ? addDays(lastDeploy, -1) : fullStart;
  const github = new GitHubProvider({ ...config.github });
  log(`GitHub: fetching merged changes on ${config.github.repo} ${deployStart} → ${end}...`);
  const deploys = await github.getDeploys({ start: deployStart, end });
  await saveDeploys(db, orgId, deploys);
  log(`GitHub: stored ${deploys.length} deploys (${github.client.requestCount} API requests).`);

  return { costs: costs.length, deploys: deploys.length, start: fullStart, end };
}
