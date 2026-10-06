import type { Attribution, CostAnomaly, CostRecord, Deploy, Service } from "@commitcost/core";
import { parseIsoDate, toIsoDate } from "@commitcost/core";
import type { PrismaClient } from "@prisma/client";

/** Rows per transaction. Keeps SQLite's variable limit and memory in check. */
const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Idempotent: re-saving the same day/service/tag overwrites the amount. */
export async function saveCostRecords(db: PrismaClient, orgId: string, records: CostRecord[]): Promise<number> {
  for (const batch of chunks(records)) {
    await db.$transaction(
      batch.map((r) => {
        const key = {
          orgId,
          date: parseIsoDate(r.date),
          provider: r.provider,
          accountId: r.accountId,
          service: r.service,
          tagKey: r.tagKey,
          tagValue: r.tagValue,
        };
        return db.costRecord.upsert({
          where: { orgId_date_provider_accountId_service_tagKey_tagValue: key },
          create: { ...key, amountUsd: r.amountUsd, source: r.source },
          update: { amountUsd: r.amountUsd, source: r.source, fetchedAt: new Date() },
        });
      }),
    );
  }
  return records.length;
}

/** Idempotent on (org, repo, commitSha). Files are replaced on re-save. */
export async function saveDeploys(db: PrismaClient, orgId: string, deploys: Deploy[]): Promise<number> {
  for (const batch of chunks(deploys, 100)) {
    await db.$transaction(
      batch.map((d) => {
        const data = {
          prNumber: d.prNumber,
          mergedAt: new Date(d.mergedAt),
          author: d.author,
          title: d.title,
          body: d.body ?? null,
          url: d.url ?? null,
        };
        const files = d.files.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
        }));
        return db.deploy.upsert({
          where: { orgId_repo_commitSha: { orgId, repo: d.repo, commitSha: d.commitSha } },
          create: { orgId, repo: d.repo, commitSha: d.commitSha, ...data, files: { create: files } },
          update: { ...data, files: { deleteMany: {}, create: files } },
        });
      }),
    );
  }
  return deploys.length;
}

/** Removes an organization's cost, change and analysis data (not its connections). */
export async function clearOrgData(db: PrismaClient, orgId: string): Promise<void> {
  await db.$transaction([
    db.costAnomaly.deleteMany({ where: { orgId } }),
    db.costRecord.deleteMany({ where: { orgId } }),
    db.deploy.deleteMany({ where: { orgId } }),
  ]);
}

export interface DailyServiceTotal {
  date: string;
  service: Service;
  amountUsd: number;
}

/** Sums tag-level rows into one total per day and service. */
export async function loadDailyServiceTotals(db: PrismaClient, orgId: string): Promise<DailyServiceTotal[]> {
  const rows = await db.costRecord.groupBy({
    where: { orgId },
    by: ["date", "service"],
    _sum: { amountUsd: true },
    orderBy: [{ date: "asc" }, { service: "asc" }],
  });
  return rows.map((r) => ({
    date: toIsoDate(r.date),
    service: r.service as Service,
    amountUsd: r._sum.amountUsd ?? 0,
  }));
}

export async function loadCostRecords(db: PrismaClient, orgId: string, range?: { start: string; end: string }): Promise<CostRecord[]> {
  const rows = await db.costRecord.findMany({
    where: { orgId, ...(range ? { date: { gte: parseIsoDate(range.start), lte: parseIsoDate(range.end) } } : {}) },
    orderBy: [{ date: "asc" }],
  });
  return rows.map((r) => ({
    date: toIsoDate(r.date),
    provider: r.provider as CostRecord["provider"],
    accountId: r.accountId,
    service: r.service as Service,
    tagKey: r.tagKey,
    tagValue: r.tagValue,
    amountUsd: r.amountUsd,
    source: r.source as CostRecord["source"],
  }));
}

export async function loadDeploys(db: PrismaClient, orgId: string, repo?: string): Promise<Deploy[]> {
  const rows = await db.deploy.findMany({ where: { orgId, ...(repo ? { repo } : {}) }, include: { files: true }, orderBy: { mergedAt: "asc" } });
  return rows.map((d) => ({
    repo: d.repo,
    commitSha: d.commitSha,
    prNumber: d.prNumber,
    mergedAt: d.mergedAt.toISOString(),
    author: d.author,
    title: d.title,
    body: d.body ?? undefined,
    url: d.url ?? undefined,
    files: d.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, patch: f.patch ?? undefined })),
  }));
}

/** Latest stored cost day for a source (and account), so syncs can be incremental. */
export async function latestCostDate(db: PrismaClient, orgId: string, source: CostRecord["source"], accountId?: string): Promise<string | null> {
  const row = await db.costRecord.findFirst({ where: { orgId, source, ...(accountId ? { accountId } : {}) }, orderBy: { date: "desc" }, select: { date: true } });
  return row ? toIsoDate(row.date) : null;
}

export async function latestDeployDate(db: PrismaClient, orgId: string, repo: string): Promise<string | null> {
  const row = await db.deploy.findFirst({ where: { orgId, repo }, orderBy: { mergedAt: "desc" }, select: { mergedAt: true } });
  return row ? toIsoDate(row.mergedAt) : null;
}

/**
 * Replaces an organization's stored analysis results. Anomalies are derived
 * data, so each run rewrites them rather than merging with the last run.
 */
export async function saveAnalysis(db: PrismaClient, orgId: string, reports: { anomaly: CostAnomaly; suspects: Attribution[] }[], provider = "aws"): Promise<void> {
  const deploys = await db.deploy.findMany({ where: { orgId }, select: { id: true, repo: true, commitSha: true } });
  const deployId = new Map(deploys.map((d) => [`${d.repo}@${d.commitSha}`, d.id]));
  const idFor = (s: Attribution) => deployId.get(`${s.repo}@${s.commitSha}`);

  await db.$transaction(async (tx) => {
    await tx.costAnomaly.deleteMany({ where: { orgId, provider } });
    for (const { anomaly: a, suspects } of reports) {
      await tx.costAnomaly.create({
        data: {
          orgId,
          provider,
          service: a.service,
          tagValue: a.tagValue ?? "",
          onsetDate: parseIsoDate(a.onsetDate),
          durationDays: a.durationDays,
          baselineUsd: a.baselineUsd,
          observedUsd: a.observedUsd,
          deltaUsd: a.deltaUsd,
          direction: a.direction,
          score: a.score,
          persistent: a.persistent,
          estimatedMonthlyImpactUsd: a.estimatedMonthlyImpactUsd,
          attributions: {
            create: suspects
              .filter((s) => idFor(s))
              .map((s) => ({
                deployId: idFor(s)!,
                rank: s.rank,
                confidence: s.confidence,
                scores: s.scores as unknown as object,
                evidence: s.evidence as unknown as object,
                explanation: s.explanation,
                explanationSource: s.explanationSource,
                estimatedMonthlyImpactUsd: s.estimatedMonthlyImpactUsd,
              })),
          },
        },
      });
    }
  });
}
