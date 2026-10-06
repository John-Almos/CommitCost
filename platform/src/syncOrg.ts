import type { CostProvider, VcsProvider } from "@commitcost/core";
import { addDays, toIsoDate } from "@commitcost/core";
import {
  type AwsConnection,
  latestCostDate,
  latestDeployDate,
  loadCostRecords,
  loadDeploys,
  type Organization,
  saveAnalysis,
  saveCostRecords,
  saveDeploys,
  type PrismaClient,
  type TrackedRepo,
} from "@commitcost/db";
import { analyze, type Explainer } from "@commitcost/engine";
import { AwsCostExplorerProvider, type CostMetric, GitHubProvider } from "@commitcost/providers";
import { costExplorerForRole, type AwsDeps } from "./aws.js";
import type { GitHubApp } from "./githubApp.js";

/** Cost Explorer revises the last few days; always re-fetch them. */
const COST_OVERLAP_DAYS = 3;

export interface SyncDeps {
  days: number;
  /** Cost source for one connected AWS account. */
  costProviderFor(conn: AwsConnection, org: Organization): Promise<CostProvider>;
  /** Change source for one tracked repository. */
  vcsProviderFor(repo: TrackedRepo & { installation: { installationId: number } }): Promise<VcsProvider>;
  explainer?: Explainer;
  today?: () => string;
}

/** Production wiring: assume the customer's role, mint an installation token. */
export function liveSyncDeps(opts: { days: number; githubApp: GitHubApp | null; aws?: AwsDeps; explainer?: Explainer }): SyncDeps {
  return {
    days: opts.days,
    explainer: opts.explainer,
    async costProviderFor(conn, org) {
      const client = await costExplorerForRole(conn.roleArn, org.awsExternalId, `commitcost-${org.slug}`, opts.aws);
      return new AwsCostExplorerProvider({
        client,
        accountId: conn.accountId,
        tagKey: conn.tagKey || undefined,
        metric: conn.costMetric as CostMetric,
      });
    },
    async vcsProviderFor(repo) {
      if (!opts.githubApp) throw new Error("The GitHub App is not configured on this CommitCost server.");
      const token = await opts.githubApp.installationToken(repo.installation.installationId);
      return new GitHubProvider({ repo: repo.fullName, branch: repo.defaultBranch, token, baseUrl: opts.githubApp.config.apiUrl });
    },
  };
}

export interface SyncSummary {
  costRecords: number;
  deploys: number;
  anomalies: number;
  errors: string[];
}

/**
 * Pulls every connected AWS account and tracked repo for one organization,
 * then re-runs anomaly detection and attribution over its data. One failing
 * connection doesn't stop the others; its error is recorded on the
 * connection and in the summary.
 */
export async function syncOrganization(db: PrismaClient, orgId: string, deps: SyncDeps, log: (line: string) => Promise<void> | void = () => {}): Promise<SyncSummary> {
  const org = await db.organization.findUniqueOrThrow({
    where: { id: orgId },
    include: { awsAccounts: true, repos: { include: { installation: { select: { installationId: true, suspended: true } } } } },
  });
  if (org.isDemo) throw new Error("The demo workspace uses mock data and is never synced.");

  const end = addDays(deps.today?.() ?? toIsoDate(new Date()), -1);
  const fullStart = addDays(end, -(deps.days - 1));
  const summary: SyncSummary = { costRecords: 0, deploys: 0, anomalies: 0, errors: [] };

  for (const conn of org.awsAccounts) {
    try {
      const last = await latestCostDate(db, org.id, "aws-cost-explorer", conn.accountId);
      const start = last && last >= fullStart ? addDays(last, -COST_OVERLAP_DAYS) : fullStart;
      await log(`AWS ${conn.accountId}: fetching daily costs ${start} → ${end}…`);
      const costs = await (await deps.costProviderFor(conn, org)).getDailyCosts({ start, end });
      await saveCostRecords(db, org.id, costs);
      summary.costRecords += costs.length;
      await db.awsConnection.update({ where: { id: conn.id }, data: { status: "active", lastError: null } });
      await log(`AWS ${conn.accountId}: stored ${costs.length} cost records.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`AWS ${conn.accountId}: ${msg}`);
      await db.awsConnection.update({ where: { id: conn.id }, data: { status: "error", lastError: msg.slice(0, 1000) } });
      await log(`AWS ${conn.accountId}: failed: ${msg}`);
    }
  }

  for (const repo of org.repos) {
    if (repo.installation.suspended) {
      await log(`GitHub ${repo.fullName}: skipped, the GitHub App installation is suspended.`);
      continue;
    }
    try {
      const last = await latestDeployDate(db, org.id, repo.fullName);
      const start = last && last >= fullStart ? addDays(last, -1) : fullStart;
      await log(`GitHub ${repo.fullName}: fetching merged changes ${start} → ${end}…`);
      const deploys = await (await deps.vcsProviderFor(repo)).getDeploys({ start, end });
      await saveDeploys(db, org.id, deploys);
      summary.deploys += deploys.length;
      await log(`GitHub ${repo.fullName}: stored ${deploys.length} changes.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`GitHub ${repo.fullName}: ${msg}`);
      await log(`GitHub ${repo.fullName}: failed: ${msg}`);
    }
  }

  const [costs, deploys] = await Promise.all([loadCostRecords(db, org.id), loadDeploys(db, org.id)]);
  if (costs.length === 0) {
    await log("No cost data yet, skipping analysis.");
    return summary;
  }
  await log(`Analyzing ${costs.length} cost records against ${deploys.length} changes…`);
  const reports = await analyze(costs, deploys, {
    explainer: deps.explainer,
    onExplainerError: (err) => void log(`LLM explanation failed, using heuristic text: ${err instanceof Error ? err.message : err}`),
  });
  await saveAnalysis(db, org.id, reports);
  summary.anomalies = reports.length;
  await log(`Found ${reports.length} cost changes.`);
  return summary;
}
