import type { Service } from "@commitcost/core";
import { USAGE_REGION_CODES, stripRegionPrefix } from "./regions.js";

/** Where a billed usage type sits in the price book. */
export interface PriceKey {
  region: string;
  /** Price list offer code, e.g. "AmazonEC2". */
  offer: string;
  /** Usage type as the price book keys it. */
  key: string;
}

/** "db.r6g.2xl" (as usage types abbreviate it) -> "db.r6g.2xlarge". */
export function expandRdsClass(cls: string): string {
  return cls.replace(/\.(\d+)xl$/, ".$1xlarge").replace(/\.xl$/, ".xlarge");
}

/**
 * Maps a usage type from the bill onto the price book, e.g.
 * ("USW2-BoxUsage:m5.large", "EC2") -> us-west-2 / AmazonEC2 / BoxUsage:m5.large.
 * RDS usage types don't name the engine; `rdsEngine` fills it in.
 */
export function priceKeyForUsage(raw: string, service: Service, rdsEngine = "postgres"): PriceKey | undefined {
  const { region = "us-east-1", usageType: u } = stripRegionPrefix(raw);
  const at = (offer: string, key = u): PriceKey => ({ region, offer, key });

  if (/^(BoxUsage:|NatGateway-(Hours|Bytes)$|EBS:VolumeUsage)/.test(u)) return at("AmazonEC2");
  const rds = u.match(/^(InstanceUsage|Multi-AZUsage):(db\..+)$/);
  if (rds) return at("AmazonRDS", `${rds[1]}:${expandRdsClass(rds[2]!)}@${rdsEngine}`);
  if (/^RDS:/.test(u)) return at("AmazonRDS");
  if (/^(DataTransfer-Regional-Bytes|DataTransfer-Out-Bytes)$/.test(u)) return at("AWSDataTransfer");
  const dest = u.match(/^([A-Z0-9]+)-AWS-Out-Bytes$/)?.[1];
  if (dest && USAGE_REGION_CODES[dest]) return at("AWSDataTransfer");
  if (service === "Lambda" && /^(Lambda-|Request)/.test(u)) return at("AWSLambda");
  if (service === "DynamoDB") return at("AmazonDynamoDB");
  if (service === "S3" && /^(TimedStorage|Requests-Tier)/.test(u)) return at("AmazonS3");
  if (u === "DataProcessing-Bytes") return at("AmazonCloudWatch", "Logs-Ingestion-Bytes");
  return undefined;
}

/** Plain-English name for a usage type, e.g. "inter-region transfer us-east-1 → us-west-2", "storage (STANDARD), us-west-2". */
export function describeUsageType(raw: string): string {
  const { region: prefixed, usageType: u } = stripRegionPrefix(raw);
  const region = prefixed ?? "us-east-1";
  const name = describe(u, region);
  // Name the region when the bill does, unless the description already says it.
  return prefixed && !name.includes(region) ? `${name}, ${region}` : name;
}

function describe(u: string, region: string): string {
  const box = u.match(/^BoxUsage:(.+)$/);
  if (box) return `EC2 ${box[1]} instance hours`;
  const rds = u.match(/^(InstanceUsage|Multi-AZUsage):(db\..+)$/);
  if (rds) return `RDS ${expandRdsClass(rds[2]!)}${rds[1] === "Multi-AZUsage" ? " Multi-AZ" : ""} instance hours`;
  const dest = u.match(/^([A-Z0-9]+)-AWS-Out-Bytes$/)?.[1];
  if (dest && USAGE_REGION_CODES[dest]) return `inter-region transfer ${region} → ${USAGE_REGION_CODES[dest]}`;
  const names: Record<string, string> = {
    "DataTransfer-Regional-Bytes": "cross-AZ transfer",
    "DataTransfer-Out-Bytes": "internet egress",
    "DataTransfer-In-Bytes": "data in (free)",
    "NatGateway-Hours": "NAT gateway hours",
    "NatGateway-Bytes": "NAT gateway data processed",
    "Lambda-GB-Second": "Lambda compute (GB-seconds)",
    "Lambda-GB-Second-ARM": "Lambda compute, Arm (GB-seconds)",
    Request: "Lambda requests",
    "Request-ARM": "Lambda requests, Arm",
    ReadRequestUnits: "DynamoDB on-demand reads",
    WriteRequestUnits: "DynamoDB on-demand writes",
    "ReadCapacityUnit-Hrs": "DynamoDB provisioned read capacity",
    "WriteCapacityUnit-Hrs": "DynamoDB provisioned write capacity",
    "TimedStorage-ByteHrs": "storage (STANDARD)",
    "Requests-Tier1": "S3 PUT/COPY/POST/LIST requests",
    "Requests-Tier2": "S3 GET and other requests",
    "DataProcessing-Bytes": "CloudWatch Logs ingestion",
  };
  if (names[u]) return names[u]!;
  if (/^EBS:VolumeUsage/.test(u)) return `EBS ${u.split(".")[1] ?? "magnetic"} storage`;
  if (/^RDS:.*Storage/.test(u)) return `RDS ${u.replace(/^RDS:/, "").replace(/-Storage$/, "")} storage`;
  return u;
}

/** Network path a usage type bills, if it is data transfer. */
export type NetworkPath = "cross-az" | "inter-region" | "internet-egress" | "nat";

export function networkPath(raw: string): NetworkPath | undefined {
  const { usageType: u } = stripRegionPrefix(raw);
  if (u === "DataTransfer-Regional-Bytes") return "cross-az";
  if (u === "DataTransfer-Out-Bytes") return "internet-egress";
  if (/^NatGateway-Bytes$/.test(u)) return "nat";
  if (/-AWS-Out-Bytes$/.test(u)) return "inter-region";
  return undefined;
}
