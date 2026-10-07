import type { Attribution, CostAnomaly, CostRecord, Deploy, Service, UsageRecord } from "@commitcost/core";
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
export async function saveCostRecords(db: PrismaClient, records: CostRecord[]): Promise<number> {
  for (const batch of chunks(records)) {
    await db.$transaction(
      batch.map((r) => {
        const key = {
          date: parseIsoDate(r.date),
          provider: r.provider,
          accountId: r.accountId,
          service: r.service,
          tagKey: r.tagKey,
          tagValue: r.tagValue,
        };
        return db.costRecord.upsert({
          where: { date_provider_accountId_service_tagKey_tagValue: key },
          create: { ...key, amountUsd: r.amountUsd, source: r.source },
          update: { amountUsd: r.amountUsd, source: r.source, fetchedAt: new Date() },
        });
      }),
    );
  }
  return records.length;
}

/**
 * Replaces stored usage for the days and sources in `records`, so a re-sync
 * of overlapping days overwrites rather than duplicates.
 */
export async function saveUsageRecords(db: PrismaClient, records: UsageRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const dates = records.map((r) => r.date).sort();
  const sources = [...new Set(records.map((r) => r.source))];
  await db.usageRecord.deleteMany({ where: { source: { in: sources }, date: { gte: parseIsoDate(dates[0]!), lte: parseIsoDate(dates[dates.length - 1]!) } } });
  for (const batch of chunks(records, 1000)) {
    await db.usageRecord.createMany({
      data: batch.map((r) => ({
        date: parseIsoDate(r.date),
        provider: r.provider,
        accountId: r.accountId,
        service: r.service,
        usageType: r.usageType,
        tagKey: r.tagKey,
        tagValue: r.tagValue,
        unit: r.unit,
        quantity: r.quantity,
        costUsd: r.costUsd,
        source: r.source,
      })),
    });
  }
  return records.length;
}

export async function loadUsageRecords(db: PrismaClient, range?: { start: string; end: string }): Promise<UsageRecord[]> {
  const rows = await db.usageRecord.findMany({
    where: range ? { date: { gte: parseIsoDate(range.start), lte: parseIsoDate(range.end) } } : undefined,
    orderBy: [{ date: "asc" }],
  });
  return rows.map((r) => ({
    date: toIsoDate(r.date),
    provider: r.provider as UsageRecord["provider"],
    accountId: r.accountId,
    service: r.service as Service,
    usageType: r.usageType,
    tagKey: r.tagKey,
    tagValue: r.tagValue,
    unit: r.unit,
    quantity: r.quantity,
    costUsd: r.costUsd,
    source: r.source as UsageRecord["source"],
  }));
}

/** Idempotent on (repo, commitSha). Files are replaced on re-save. */
export async function saveDeploys(db: PrismaClient, deploys: Deploy[]): Promise<number> {
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
          where: { repo_commitSha: { repo: d.repo, commitSha: d.commitSha } },
          create: { repo: d.repo, commitSha: d.commitSha, ...data, files: { create: files } },
          update: { ...data, files: { deleteMany: {}, create: files } },
        });
      }),
    );
  }
  return deploys.length;
}

/** Removes everything produced from mock mode so a re-seed starts clean. */
export async function clearMockData(db: PrismaClient, mockRepo: string): Promise<void> {
  await db.$transaction([
    db.costAnomaly.deleteMany({}),
    db.costRecord.deleteMany({ where: { source: "mock" } }),
    db.usageRecord.deleteMany({ where: { source: "mock" } }),
    db.deploy.deleteMany({ where: { repo: mockRepo } }),
    db.repoMeta.deleteMany({ where: { repo: mockRepo } }),
  ]);
}

/** Stores the repository's CODEOWNERS file (null when it has none). */
export async function saveCodeowners(db: PrismaClient, repo: string, codeowners: string | null): Promise<void> {
  await db.repoMeta.upsert({ where: { repo }, create: { repo, codeowners }, update: { codeowners } });
}

/** The stored CODEOWNERS file for a repo, or for the only repo when none is given. */
export async function loadCodeowners(db: PrismaClient, repo?: string): Promise<string | undefined> {
  const row = repo ? await db.repoMeta.findUnique({ where: { repo } }) : await db.repoMeta.findFirst({ orderBy: { updatedAt: "desc" } });
  return row?.codeowners ?? undefined;
}

export interface DailyServiceTotal {
  date: string;
  service: Service;
  amountUsd: number;
}

/** Sums tag-level rows into one total per day and service. */
export async function loadDailyServiceTotals(db: PrismaClient): Promise<DailyServiceTotal[]> {
  const rows = await db.costRecord.groupBy({
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

export async function loadCostRecords(db: PrismaClient, range?: { start: string; end: string }): Promise<CostRecord[]> {
  const rows = await db.costRecord.findMany({
    where: range ? { date: { gte: parseIsoDate(range.start), lte: parseIsoDate(range.end) } } : undefined,
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

export async function loadDeploys(db: PrismaClient, repo?: string): Promise<Deploy[]> {
  const rows = await db.deploy.findMany({ where: repo ? { repo } : undefined, include: { files: true }, orderBy: { mergedAt: "asc" } });
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

/** Every stored anomaly with its rank-1 suspect, as plain data for receipts, the code cost map and fix patches. */
export async function loadTopAttributions(db: PrismaClient): Promise<TopAttributionRow[]> {
  const rows = await db.attribution.findMany({ where: { rank: 1 }, include: { anomaly: true, deploy: { select: { commitSha: true } } } });
  return rows.map((r) => ({
    anomalyId: r.anomalyId,
    service: r.anomaly.service as Service,
    tagValue: r.anomaly.tagValue,
    onsetDate: toIsoDate(r.anomaly.onsetDate),
    direction: r.anomaly.direction as "increase" | "decrease",
    persistent: r.anomaly.persistent,
    monthlyUsd: r.anomaly.estimatedMonthlyImpactUsd,
    commitSha: r.deploy.commitSha,
    confidence: r.confidence,
    evidence: ((r.evidence as unknown as { file: string; line?: number }[] | null) ?? []).map((e) => ({ file: e.file, line: e.line })),
  }));
}

/** Same shape as the engine's TopAttribution (db doesn't depend on the engine at runtime). */
export interface TopAttributionRow {
  anomalyId: string;
  service: Service;
  tagValue: string;
  onsetDate: string;
  direction: "increase" | "decrease";
  persistent: boolean;
  monthlyUsd: number;
  commitSha: string;
  confidence: number;
  evidence: { file: string; line?: number }[];
}

/** Latest stored cost day for a source, so syncs can be incremental. */
export async function latestCostDate(db: PrismaClient, source: CostRecord["source"]): Promise<string | null> {
  const row = await db.costRecord.findFirst({ where: { source }, orderBy: { date: "desc" }, select: { date: true } });
  return row ? toIsoDate(row.date) : null;
}

export async function latestDeployDate(db: PrismaClient, repo: string): Promise<string | null> {
  const row = await db.deploy.findFirst({ where: { repo }, orderBy: { mergedAt: "desc" }, select: { mergedAt: true } });
  return row ? toIsoDate(row.mergedAt) : null;
}

/**
 * Replaces stored analysis results. Anomalies are derived data, so each run
 * rewrites them rather than merging with the last run.
 */
export async function saveAnalysis(db: PrismaClient, reports: { anomaly: CostAnomaly; suspects: Attribution[] }[], repo: string, provider = "aws"): Promise<void> {
  const deploys = await db.deploy.findMany({ where: { repo }, select: { id: true, commitSha: true } });
  const deployId = new Map(deploys.map((d) => [d.commitSha, d.id]));

  await db.$transaction(async (tx) => {
    await tx.costAnomaly.deleteMany({ where: { provider } });
    for (const { anomaly: a, suspects } of reports) {
      await tx.costAnomaly.create({
        data: {
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
              .filter((s) => deployId.has(s.commitSha))
              .map((s) => ({
                deployId: deployId.get(s.commitSha)!,
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
