/**
 * AWS region codes as they appear at the start of usage types in the bill and
 * the Price List ("USW2-BoxUsage:m5.large", "USE1-USW2-AWS-Out-Bytes").
 * us-east-1 usually has no prefix.
 */
export const USAGE_REGION_CODES: Record<string, string> = {
  USE1: "us-east-1",
  USE2: "us-east-2",
  USW1: "us-west-1",
  USW2: "us-west-2",
  CAN1: "ca-central-1",
  SAE1: "sa-east-1",
  EU: "eu-west-1",
  EUW1: "eu-west-1",
  EUW2: "eu-west-2",
  EUW3: "eu-west-3",
  EUC1: "eu-central-1",
  EUN1: "eu-north-1",
  EUS1: "eu-south-1",
  APS1: "ap-southeast-1",
  APS2: "ap-southeast-2",
  APS3: "ap-south-1",
  APN1: "ap-northeast-1",
  APN2: "ap-northeast-2",
  APN3: "ap-northeast-3",
  APE1: "ap-east-1",
  MES1: "me-south-1",
  AFS1: "af-south-1",
};

const CODE_BY_REGION: Record<string, string> = Object.fromEntries(
  Object.entries(USAGE_REGION_CODES)
    .filter(([code]) => code !== "EUW1")
    .map(([code, region]) => [region, code]),
);

export function usageRegionCode(region: string): string | undefined {
  return CODE_BY_REGION[region];
}

/** "USW2-BoxUsage:m5.large" -> { region: "us-west-2", usageType: "BoxUsage:m5.large" }. */
export function stripRegionPrefix(usageType: string): { region?: string; usageType: string } {
  const m = usageType.match(/^([A-Z]{2,4}\d?)-(.+)$/);
  if (m && USAGE_REGION_CODES[m[1]!]) {
    // "USE1-USW2-AWS-Out-Bytes": the first code is the source region; keep the rest.
    return { region: USAGE_REGION_CODES[m[1]!], usageType: m[2]! };
  }
  return { usageType };
}

/** Terraform provider aliases and region-ish strings, e.g. "aws.us_west_2", "us-west-2a". */
export function regionFromText(text: string): string | undefined {
  const m = text.match(/\b(us|eu|ap|ca|sa|me|af|il|mx)[-_](north|south|east|west|central|northeast|southeast|southwest|northwest)[-_](\d)/i);
  return m ? `${m[1]!.toLowerCase()}-${m[2]!.toLowerCase()}-${m[3]}` : undefined;
}

/** Inter-region transfer usage type from one region to another, e.g. "USE1-USW2-AWS-Out-Bytes". */
export function interRegionUsageType(from: string, to: string): string | undefined {
  const a = usageRegionCode(from);
  const b = usageRegionCode(to);
  return a && b ? `${a}-${b}-AWS-Out-Bytes` : undefined;
}
