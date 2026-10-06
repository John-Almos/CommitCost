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
