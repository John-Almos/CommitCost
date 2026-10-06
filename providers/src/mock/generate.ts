import type { CostRecord, Deploy, IsoDate, Service } from "@commitcost/core";
import { SERVICES, addDays, dateRange, isWeekend, toIsoDate } from "@commitcost/core";
import { AUTHORS, randomFillerChange } from "./commits.js";
import { SERVICE_PROFILES, TAG_KEY } from "./profiles.js";
import { Rng } from "./rng.js";
import {
  DECOYS,
  INJECTED_CHANGES,
  UNEXPLAINED_EVENTS,
  type CostEffect,
  type InjectedChange,
  type InjectedKind,
} from "./scenario.js";

export const MOCK_REPO = "acme/storefront";
export const MOCK_ACCOUNT_ID = "123456789012";
export const DEFAULT_SEED = 42;
export const DEFAULT_DAYS = 90;

export interface MockOptions {
  seed?: number;
  /** Last day of data, inclusive. Defaults to yesterday (UTC), like Cost Explorer. */
  endDate?: IsoDate;
  /** Window length in days. Must fit the scenario (at least 85). */
  days?: number;
}

/** Ground truth for one injected cost change. */
export interface InjectedSpike {
  key: string;
  kind: InjectedKind;
  commitSha: string;
  prNumber: number;
  title: string;
  author: string;
  mergedAt: string;
  onsetDate: IsoDate;
  lagDays: number;
  direction: "increase" | "decrease";
  effects: CostEffect[];
  /** Sum of effects' daily deltas, before weekly seasonality. */
  dailyDeltaUsd: number;
  estimatedMonthlyImpactUsd: number;
  why: string;
}

export interface MockDataset {
  seed: number;
  repo: string;
  start: IsoDate;
  end: IsoDate;
  costs: CostRecord[];
  deploys: Deploy[];
  /** Cost changes caused by a specific commit, in onset order. */
  spikes: InjectedSpike[];
  /** Cost blips with no code cause. Attribution should report low confidence. */
  unexplained: { key: string; date: IsoDate; service: Service; tagValue: string; deltaUsd: number; why: string }[];
}

const MIN_DAYS = 85;

function yesterdayUtc(): IsoDate {
  return addDays(toIsoDate(new Date()), -1);
}

function timestamp(date: IsoDate, hour: number, minute: number): string {
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

/** Fraction of an effect in force on a given day index. */
function effectProgress(dayIndex: number, onsetDay: number, rampDays: number): number {
  if (dayIndex < onsetDay) return 0;
  if (rampDays <= 0) return 1;
  return Math.min(1, (dayIndex - onsetDay + 1) / (rampDays + 1));
}

/**
 * Builds a deterministic 90-day dataset: daily AWS costs by service and `app`
 * tag, a merged-PR history, and the ground truth for every injected spike.
 * Pure: reads no environment variables and needs no credentials.
 */
export function generateMockDataset(options: MockOptions = {}): MockDataset {
  const seed = options.seed ?? DEFAULT_SEED;
  const days = options.days ?? DEFAULT_DAYS;
  if (days < MIN_DAYS) throw new Error(`Mock data needs at least ${MIN_DAYS} days to fit the scenario, got ${days}`);
  const end = options.endDate ?? yesterdayUtc();
  const start = addDays(end, -(days - 1));
  const dates = dateRange(start, end);

  // Scenario days are placed relative to a 90-day window; longer windows shift
  // them right so the spikes stay in the most recent 90 days.
  const offset = days - DEFAULT_DAYS;

  const root = new Rng(seed);
  const deploys = buildHistory(root.fork("history"), dates, offset);
  const spikes = buildSpikeTruth(deploys.injected, dates, offset);
  const costs = buildCosts(root.fork("costs"), dates, offset);

  return {
    seed,
    repo: MOCK_REPO,
    start,
    end,
    costs,
    deploys: deploys.all,
    spikes,
    unexplained: UNEXPLAINED_EVENTS.map((e) => ({
      key: e.key,
      date: dates[e.day + offset]!,
      service: e.service,
      tagValue: e.tagValue,
      deltaUsd: e.deltaUsd,
      why: e.why,
    })),
  };
}

function buildCosts(rng: Rng, dates: IsoDate[], offset: number): CostRecord[] {
  const records: CostRecord[] = [];
  dates.forEach((date, i) => {
    const weekend = isWeekend(date);
    for (const service of SERVICES) {
      const profile = SERVICE_PROFILES[service];
      const seasonal = weekend ? profile.weekendFactor : 1;
      const growth = Math.pow(1 + profile.dailyGrowth, i);

      for (const [tagValue, share] of Object.entries(profile.tagShares)) {
        let amount = profile.baseDailyUsd * share * seasonal * growth;

        for (const change of INJECTED_CHANGES) {
          for (const effect of change.effects) {
            if (effect.service !== service || effect.tagValue !== tagValue) continue;
            const progress = effectProgress(i, change.onsetDay + offset, effect.rampDays);
            amount += effect.dailyDeltaUsd * progress * (effect.followsTraffic ? seasonal : 1);
          }
        }
        for (const event of UNEXPLAINED_EVENTS) {
          if (event.service === service && event.tagValue === tagValue && event.day + offset === i) {
            amount += event.deltaUsd;
          }
        }

        amount *= 1 + profile.noise * rng.gaussian();
        records.push({
          date,
          provider: "aws",
          accountId: MOCK_ACCOUNT_ID,
          service,
          tagKey: TAG_KEY,
          tagValue,
          amountUsd: Math.max(0, Math.round(amount * 100) / 100),
          source: "mock",
        });
      }
    }
  });
  return records;
}

interface PendingDeploy extends Omit<Deploy, "prNumber" | "url" | "commitSha" | "repo"> {
  injectedKey?: string;
}

function buildHistory(rng: Rng, dates: IsoDate[], offset: number) {
  const pending: PendingDeploy[] = [];

  // Background merges: a few per weekday, the odd one at the weekend.
  for (const date of dates) {
    const count = isWeekend(date) ? (rng.chance(0.15) ? 1 : 0) : rng.int(1, 3);
    for (let n = 0; n < count; n++) {
      const change = randomFillerChange(rng);
      pending.push({
        mergedAt: timestamp(date, rng.int(13, 23), rng.int(0, 59)),
        author: rng.pick(AUTHORS),
        title: change.title,
        files: change.files,
      });
    }
  }

  const byKey = new Map(INJECTED_CHANGES.map((c) => [c.key, c]));
  for (const change of INJECTED_CHANGES) {
    const mergeDate = dates[change.onsetDay + offset - change.lagDays]!;
    pending.push({
      mergedAt: timestamp(mergeDate, change.mergeHourUtc, rng.int(0, 59)),
      author: change.author,
      title: change.title,
      body: change.body,
      files: change.files,
      injectedKey: change.key,
    });
  }
  for (const decoy of DECOYS) {
    const target = byKey.get(decoy.near);
    if (!target) throw new Error(`Decoy refers to unknown change ${decoy.near}`);
    const date = dates[target.onsetDay + offset - target.lagDays - decoy.daysBefore]!;
    // Same-day decoys merge a little before the real change.
    const hour = decoy.daysBefore === 0 ? Math.max(0, target.mergeHourUtc - 3) : rng.int(13, 22);
    pending.push({
      mergedAt: timestamp(date, hour, rng.int(0, 59)),
      author: decoy.author,
      title: decoy.title,
      files: decoy.files,
    });
  }

  pending.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));

  const injected = new Map<string, Deploy>();
  const all: Deploy[] = pending.map((p, i) => {
    const prNumber = 101 + i;
    const { injectedKey, ...rest } = p;
    const deploy: Deploy = {
      ...rest,
      repo: MOCK_REPO,
      commitSha: rng.hex(40),
      prNumber,
      url: `https://github.com/${MOCK_REPO}/pull/${prNumber}`,
    };
    if (injectedKey) injected.set(injectedKey, deploy);
    return deploy;
  });
  return { all, injected };
}

function buildSpikeTruth(injected: Map<string, Deploy>, dates: IsoDate[], offset: number): InjectedSpike[] {
  return INJECTED_CHANGES.map((change: InjectedChange) => {
    const deploy = injected.get(change.key)!;
    const dailyDeltaUsd = change.effects.reduce((sum, e) => sum + e.dailyDeltaUsd, 0);
    return {
      key: change.key,
      kind: change.kind,
      commitSha: deploy.commitSha,
      prNumber: deploy.prNumber!,
      title: change.title,
      author: change.author,
      mergedAt: deploy.mergedAt,
      onsetDate: dates[change.onsetDay + offset]!,
      lagDays: change.lagDays,
      direction: dailyDeltaUsd >= 0 ? "increase" : "decrease",
      effects: change.effects,
      dailyDeltaUsd,
      estimatedMonthlyImpactUsd: dailyDeltaUsd * 30,
      why: change.why,
    } satisfies InjectedSpike;
  });
}
