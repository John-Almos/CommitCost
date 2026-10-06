import type { Service } from "@commitcost/core";
import { loadDailyServiceTotals } from "@commitcost/db";
import { reviewFiles, type Warning } from "@commitcost/action";
import { db } from "./db";

export interface Point {
  date: string;
  usd: number;
}

export interface AnomalyMarker {
  id: string;
  date: string;
  direction: "increase" | "decrease";
  deltaUsd: number;
}

export interface ServiceSeries {
  service: Service;
  points: Point[];
  total: number;
  markers: AnomalyMarker[];
}

export interface AnomalyRow {
  id: string;
  service: Service;
  tagValue: string;
  onsetDate: string;
  durationDays: number;
  baselineUsd: number;
  observedUsd: number;
  deltaUsd: number;
  direction: "increase" | "decrease";
  persistent: boolean;
  monthlyImpactUsd: number;
  topSuspect?: { title: string; prNumber: number | null; sha: string; confidence: number };
}

export interface Evidence {
  file: string;
  line?: number;
  detail: string;
  snippet?: string;
}

export interface Suspect {
  rank: number;
  confidence: number;
  scores: { timing: number; relevance: number; total: number };
  evidence: Evidence[];
  explanation: string;
  explanationSource: string;
  monthlyImpactUsd: number;
  deploy: DeployRow;
}

export interface DeployFileRow {
  path: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface DeployRow {
  sha: string;
  repo: string;
  prNumber: number | null;
  title: string;
  author: string;
  mergedAt: string;
  url: string | null;
  files: DeployFileRow[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000));

type DeployWithFiles = { commitSha: string; repo: string; prNumber: number | null; title: string; author: string; mergedAt: Date; url: string | null; files: DeployFileRow[] };
const toDeploy = (d: DeployWithFiles): DeployRow => ({
  sha: d.commitSha,
  repo: d.repo,
  prNumber: d.prNumber,
  title: d.title,
  author: d.author,
  mergedAt: d.mergedAt.toISOString(),
  url: d.url,
  files: d.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, patch: f.patch })),
});

export async function dataMode(orgId: string): Promise<"mock" | "live" | "empty"> {
  const row = await db.costRecord.findFirst({ where: { orgId }, select: { source: true } });
  return !row ? "empty" : row.source === "mock" ? "mock" : "live";
}

async function anomalyRows(orgId: string, where: object = {}): Promise<AnomalyRow[]> {
  const rows = await db.costAnomaly.findMany({
    where: { ...where, orgId },
    orderBy: { onsetDate: "asc" },
    include: { attributions: { where: { rank: 1 }, include: { deploy: true } } },
  });
  return rows.map((a) => {
    const top = a.attributions[0];
    return {
      id: a.id,
      service: a.service as Service,
      tagValue: a.tagValue,
      onsetDate: iso(a.onsetDate),
      durationDays: a.durationDays,
      baselineUsd: a.baselineUsd,
      observedUsd: a.observedUsd,
      deltaUsd: a.deltaUsd,
      direction: a.direction as AnomalyRow["direction"],
      persistent: a.persistent,
      monthlyImpactUsd: a.estimatedMonthlyImpactUsd,
      topSuspect: top && { title: top.deploy.title, prNumber: top.deploy.prNumber, sha: top.deploy.commitSha, confidence: top.confidence },
    };
  });
}

function seriesFor(totals: { date: string; service: Service; amountUsd: number }[], start: string, anomalies: AnomalyRow[]): ServiceSeries[] {
  const byService = new Map<Service, Point[]>();
  for (const t of totals) {
    if (t.date < start) continue;
    const pts = byService.get(t.service) ?? [];
    pts.push({ date: t.date, usd: t.amountUsd });
    byService.set(t.service, pts);
  }
  return [...byService.entries()]
    .map(([service, points]) => ({
      service,
      points,
      total: points.reduce((s, p) => s + p.usd, 0),
      markers: anomalies
        .filter((a) => a.service === service && a.onsetDate >= start)
        .map((a) => ({ id: a.id, date: a.onsetDate, direction: a.direction, deltaUsd: a.deltaUsd })),
    }))
    .sort((a, b) => b.total - a.total);
}

export async function getOverview(orgId: string, rangeDays: number) {
  const totals = await loadDailyServiceTotals(db, orgId);
  if (totals.length === 0) return null;
  const end = totals[totals.length - 1]!.date;
  const start = addDays(end, -(rangeDays - 1));
  const anomalies = await anomalyRows(orgId);
  const inRange = anomalies.filter((a) => a.onsetDate >= start);

  const sumBetween = (from: string, to: string) => totals.filter((t) => t.date >= from && t.date <= to).reduce((s, t) => s + t.amountUsd, 0);
  const last30 = sumBetween(addDays(end, -29), end);
  const prev30 = sumBetween(addDays(end, -59), addDays(end, -30));
  const days = new Set(totals.filter((t) => t.date >= start).map((t) => t.date)).size;

  // Changes still on the bill: persistent anomalies and their top suspect.
  const netMonthly = inRange.filter((a) => a.persistent).reduce((s, a) => s + a.monthlyImpactUsd, 0);
  const top = inRange
    .filter((a) => a.topSuspect && a.topSuspect.confidence >= 0.4)
    .sort((a, b) => Math.abs(b.monthlyImpactUsd) - Math.abs(a.monthlyImpactUsd));

  return {
    start,
    end,
    days,
    rangeSpend: sumBetween(start, end),
    last30,
    prev30,
    anomalies: inRange,
    netMonthly,
    series: seriesFor(totals, start, inRange),
    topChanges: top,
  };
}

export async function getAnomaly(orgId: string, id: string) {
  const a = await db.costAnomaly.findFirst({
    where: { id, orgId },
    include: { attributions: { orderBy: { rank: "asc" }, include: { deploy: { include: { files: true } } } } },
  });
  if (!a) return null;
  const [row] = await anomalyRows(orgId, { id });
  const onset = iso(a.onsetDate);
  const totals = (await loadDailyServiceTotals(db, orgId)).filter((t) => t.service === a.service);
  const start = addDays(onset, -28);
  const endCut = addDays(onset, 21);
  const points = totals.filter((t) => t.date >= start && t.date <= endCut).map((t) => ({ date: t.date, usd: t.amountUsd }));
  const others = (await anomalyRows(orgId, { service: a.service })).filter((o) => o.onsetDate >= start && o.onsetDate <= endCut);

  const suspects: Suspect[] = a.attributions.map((s) => ({
    rank: s.rank,
    confidence: s.confidence,
    scores: s.scores as unknown as Suspect["scores"],
    evidence: (s.evidence as unknown as Evidence[]) ?? [],
    explanation: s.explanation,
    explanationSource: s.explanationSource,
    monthlyImpactUsd: s.estimatedMonthlyImpactUsd,
    deploy: toDeploy(s.deploy),
  }));
  const topWarnings = suspects[0] ? warningsFor(suspects[0].deploy) : [];

  return {
    anomaly: row!,
    series: {
      service: a.service as Service,
      points,
      total: 0,
      markers: others.map((o) => ({ id: o.id, date: o.onsetDate, direction: o.direction, deltaUsd: o.deltaUsd })),
    } satisfies ServiceSeries,
    suspects,
    topWarnings,
  };
}

/** The pre-merge review the GitHub Action would have posted on this PR. */
export function warningsFor(d: DeployRow): Warning[] {
  return reviewFiles(d.files.map((f) => ({ path: f.path, patch: f.patch ?? undefined })));
}

export interface ChangeSummary extends DeployRow {
  attributed: { anomalyId: string; service: Service; onsetDate: string; confidence: number; monthlyImpactUsd: number }[];
  warnings: number;
}

export async function listChanges(orgId: string): Promise<ChangeSummary[]> {
  const rows = await db.deploy.findMany({
    where: { orgId },
    orderBy: { mergedAt: "desc" },
    include: { files: true, attributions: { where: { rank: 1 }, include: { anomaly: true } } },
  });
  return rows.map((d) => {
    const deploy = toDeploy(d);
    return {
      ...deploy,
      attributed: d.attributions
        .filter((t) => t.confidence >= 0.4)
        .map((t) => ({
          anomalyId: t.anomalyId,
          service: t.anomaly.service as Service,
          onsetDate: iso(t.anomaly.onsetDate),
          confidence: t.confidence,
          monthlyImpactUsd: t.estimatedMonthlyImpactUsd,
        })),
      warnings: warningsFor(deploy).length,
    };
  });
}

export async function getChange(orgId: string, sha: string) {
  const d = await db.deploy.findFirst({
    where: { orgId, commitSha: { startsWith: sha } },
    include: { files: true, attributions: { include: { anomaly: true }, orderBy: { confidence: "desc" } } },
  });
  if (!d) return null;
  const deploy = toDeploy(d);
  return {
    deploy,
    warnings: warningsFor(deploy),
    attributions: d.attributions.map((t) => ({
      anomalyId: t.anomalyId,
      service: t.anomaly.service as Service,
      onsetDate: iso(t.anomaly.onsetDate),
      direction: t.anomaly.direction as "increase" | "decrease",
      rank: t.rank,
      confidence: t.confidence,
      explanation: t.explanation,
      evidence: (t.evidence as unknown as Evidence[]) ?? [],
      monthlyImpactUsd: t.estimatedMonthlyImpactUsd,
    })),
  };
}
