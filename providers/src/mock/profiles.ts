import type { Service } from "@commitcost/core";

/**
 * Baseline daily spend for a ~10-engineer SaaS on AWS (about $25k/month).
 * Each service's cost is split across the `app` cost-allocation tag.
 */
export interface ServiceProfile {
  baseDailyUsd: number;
  /** Share of spend per `app` tag value. "" is untagged. Must sum to 1. */
  tagShares: Record<string, number>;
  /** Multiplier applied on Saturday and Sunday. Traffic-driven services dip. */
  weekendFactor: number;
  /** Day-to-day noise as a fraction of the row amount (1 sd). */
  noise: number;
  /** Organic growth per day (0.001 = 0.1%/day). */
  dailyGrowth: number;
}

export const TAG_KEY = "app";

export const SERVICE_PROFILES: Record<Service, ServiceProfile> = {
  EC2: {
    baseDailyUsd: 420,
    tagShares: { api: 0.45, worker: 0.35, web: 0.15, "": 0.05 },
    weekendFactor: 0.97,
    noise: 0.02,
    dailyGrowth: 0.0006,
  },
  RDS: {
    baseDailyUsd: 180,
    tagShares: { api: 0.7, worker: 0.3 },
    weekendFactor: 0.98,
    noise: 0.025,
    dailyGrowth: 0.0005,
  },
  Lambda: {
    baseDailyUsd: 30,
    tagShares: { worker: 0.8, api: 0.2 },
    weekendFactor: 0.7,
    noise: 0.05,
    dailyGrowth: 0.001,
  },
  S3: {
    baseDailyUsd: 55,
    tagShares: { api: 0.5, web: 0.3, "": 0.2 },
    weekendFactor: 1,
    noise: 0.015,
    dailyGrowth: 0.0012,
  },
  DynamoDB: {
    baseDailyUsd: 40,
    tagShares: { api: 0.75, worker: 0.25 },
    weekendFactor: 0.75,
    noise: 0.04,
    dailyGrowth: 0.0008,
  },
  DataTransfer: {
    baseDailyUsd: 50,
    tagShares: { api: 0.5, web: 0.4, "": 0.1 },
    weekendFactor: 0.8,
    noise: 0.04,
    dailyGrowth: 0.0008,
  },
};
