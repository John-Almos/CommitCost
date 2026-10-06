import type { CostRecord, Deploy, Service } from "@commitcost/core";
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
    db.costRecord.deleteMany({ where: { source: "mock" } }),
    db.deploy.deleteMany({ where: { repo: mockRepo } }),
  ]);
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
