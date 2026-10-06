import type { KnownService } from "@commitcost/core";

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

export const SERVICE_PROFILES: Record<KnownService, ServiceProfile> = {
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

/**
 * How each service/tag's baseline spend splits across usage types, as Cost
 * Explorer reports them. Quantities are derived from these shares and the
 * bundled list prices, so mock usage, mock cost and the price book agree.
 */
export const USAGE_MIX: Record<KnownService, Record<string, [usageType: string, share: number][]>> = {
  EC2: {
    api: [["BoxUsage:m6i.xlarge", 0.9], ["NatGateway-Hours", 0.02], ["NatGateway-Bytes", 0.08]],
    worker: [["BoxUsage:m5.xlarge", 1]],
    web: [["BoxUsage:t3.large", 1]],
    "": [["EBS:VolumeUsage.gp3", 1]],
  },
  RDS: {
    api: [["Multi-AZUsage:db.r6g.xl", 0.88], ["RDS:Multi-AZ-GP3-Storage", 0.12]],
    worker: [["Multi-AZUsage:db.r6g.large", 0.85], ["RDS:Multi-AZ-GP3-Storage", 0.15]],
  },
  Lambda: {
    worker: [["Lambda-GB-Second", 0.92], ["Request", 0.08]],
    api: [["Lambda-GB-Second", 0.85], ["Request", 0.15]],
  },
  S3: {
    api: [["TimedStorage-ByteHrs", 0.85], ["Requests-Tier2", 0.15]],
    web: [["TimedStorage-ByteHrs", 0.7], ["Requests-Tier2", 0.3]],
    "": [["TimedStorage-ByteHrs", 0.8], ["Requests-Tier1", 0.2]],
  },
  DynamoDB: {
    api: [["ReadRequestUnits", 0.6], ["WriteRequestUnits", 0.4]],
    worker: [["ReadRequestUnits", 0.3], ["WriteRequestUnits", 0.7]],
  },
  DataTransfer: {
    api: [["DataTransfer-Out-Bytes", 0.6], ["DataTransfer-Regional-Bytes", 0.4]],
    web: [["DataTransfer-Out-Bytes", 1]],
    "": [["DataTransfer-Out-Bytes", 1]],
  },
};

/** What the mock account pays vs list: a Compute Savings Plan covers EC2 instances. */
export const EFFECTIVE_RATE: Record<string, number> = { "BoxUsage:": 0.85 };

/** Free usage that still shows up in the bill: data written into the uploads bucket. */
export const FREE_USAGE: { service: KnownService; tagValue: string; usageType: string; unit: string; dailyQuantity: number }[] = [
  { service: "S3", tagValue: "", usageType: "DataTransfer-In-Bytes", unit: "GB", dailyQuantity: 3100 },
];
