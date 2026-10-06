import type { Service } from "@commitcost/core";

/**
 * Maps Cost Explorer SERVICE dimension values onto CommitCost services.
 * Anything not listed is summed into "Other".
 */
const EXACT: Record<string, Service> = {
  "Amazon Elastic Compute Cloud - Compute": "EC2",
  "EC2 - Other": "EC2",
  "Amazon EC2 Container Service": "EC2",
  "Amazon Elastic Container Service": "EC2",
  "Amazon Elastic Load Balancing": "EC2",
  "Amazon Relational Database Service": "RDS",
  "Amazon Aurora": "RDS",
  "AWS Lambda": "Lambda",
  "Amazon Simple Storage Service": "S3",
  "Amazon DynamoDB": "DynamoDB",
  "AWS Data Transfer": "DataTransfer",
  "Amazon CloudFront": "DataTransfer",
};

export function mapAwsService(name: string): Service {
  return EXACT[name] ?? "Other";
}

/** Cost Explorer SERVICE values that roll up into each CommitCost service, plus CloudWatch for log volumes. */
export function awsServiceNamesBy(): Map<Service, string[]> {
  const out = new Map<Service, string[]>();
  for (const [name, service] of Object.entries(EXACT)) out.set(service, [...(out.get(service) ?? []), name]);
  out.set("Other", ["AmazonCloudWatch"]);
  return out;
}
