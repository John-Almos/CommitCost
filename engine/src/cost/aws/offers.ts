import { USAGE_REGION_CODES, stripRegionPrefix } from "./regions.js";

/**
 * Which AWS price list products CommitCost keeps, and the key each is stored
 * under. Shared by the snapshot builder (public CSV offer files) and the live
 * Price List API loader, so both produce the same price book.
 */

/** The product attributes the filters look at, named the way the Price List API names them. */
export interface OfferProduct {
  usagetype: string;
  operation?: string;
  operatingSystem?: string;
  tenancy?: string;
  preInstalledSw?: string;
  capacitystatus?: string;
  instanceType?: string;
  licenseModel?: string;
}

/** RDS operation codes for the engines CommitCost prices. */
export const RDS_ENGINES: Record<string, string> = {
  "CreateDBInstance:0002": "mysql",
  "CreateDBInstance:0014": "postgres",
  "CreateDBInstance:0016": "aurora-mysql",
  "CreateDBInstance:0018": "mariadb",
  "CreateDBInstance:0021": "aurora-postgresql",
};

type Keep = (p: OfferProduct, usageType: string) => string | null;

export const OFFERS: Record<string, Keep> = {
  AmazonEC2: (p, u) => {
    if (/^BoxUsage:/.test(u)) {
      const linuxShared = p.operatingSystem === "Linux" && p.tenancy === "Shared" && p.preInstalledSw === "NA" && p.capacitystatus === "Used" && p.operation === "RunInstances";
      return linuxShared ? u : null;
    }
    if (/^NatGateway-(Hours|Bytes)$/.test(u)) return u;
    if (/^EBS:VolumeUsage(\.gp2|\.gp3|\.io2|\.st1)?$/.test(u)) return u;
    return null;
  },
  AmazonRDS: (p, u) => {
    const engine = RDS_ENGINES[p.operation ?? ""];
    if (!engine) return null;
    // Usage types abbreviate sizes ("db.r6g.2xl"); key by the full class name instead.
    if (/^(InstanceUsage|Multi-AZUsage):db\./.test(u) && p.licenseModel === "No license required" && p.instanceType) return `${u.split(":")[0]}:${p.instanceType}@${engine}`;
    if (/^RDS:(GP2|GP3|Multi-AZ-GP2|Multi-AZ-GP3)-Storage$/.test(u) && engine === "postgres") return u;
    return null;
  },
  AWSLambda: (_p, u) => (/^(Lambda-GB-Second|Request|Lambda-Provisioned-GB-Second|Lambda-Provisioned-Concurrency)(-ARM)?$/.test(u) ? u : null),
  AmazonDynamoDB: (_p, u) => (/^(ReadRequestUnits|WriteRequestUnits|ReadCapacityUnit-Hrs|WriteCapacityUnit-Hrs|TimedStorage-ByteHrs)$/.test(u) ? u : null),
  AmazonS3: (_p, u) =>
    /^(TimedStorage-ByteHrs|TimedStorage-SIA-ByteHrs|TimedStorage-ZIA-ByteHrs|TimedStorage-GIR-ByteHrs|TimedStorage-GlacierByteHrs|TimedStorage-GDA-ByteHrs|Requests-Tier1|Requests-Tier2)$/.test(u) ? u : null,
  // Inter-region rows to other regions only (not Local Zones or Wavelength).
  AWSDataTransfer: (_p, u) => {
    if (/^(DataTransfer-Regional-Bytes|DataTransfer-Out-Bytes)$/.test(u)) return u;
    const dest = u.match(/^([A-Z0-9]+)-AWS-Out-Bytes$/)?.[1];
    return dest && USAGE_REGION_CODES[dest] ? u : null;
  },
  AmazonCloudWatch: (p, u) => {
    if (u === "DataProcessing-Bytes" && p.operation === "PutLogEvents") return "Logs-Ingestion-Bytes";
    if (u === "TimedStorage-ByteHrs") return "Logs-Storage-ByteHrs";
    return null;
  },
};

/** Price book key for a product, or null when CommitCost doesn't use it. */
export function offerKey(offer: string, product: OfferProduct): string | null {
  const keep = OFFERS[offer];
  return keep ? keep(product, stripRegionPrefix(product.usagetype).usageType) : null;
}
