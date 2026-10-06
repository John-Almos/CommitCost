import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { addDays, toIsoDate } from "@commitcost/core";
import type { CostExplorerLike } from "@commitcost/providers";

/** Customers' roles get this name unless they change it in the template. */
export const DEFAULT_ROLE_NAME = "CommitCostReadOnly";

/** The only AWS permissions CommitCost asks for. All are read-only Cost Explorer calls. */
export const READ_ONLY_ACTIONS = ["ce:GetCostAndUsage", "ce:GetTags"] as const;

const ROLE_ARN_RE = /^arn:(aws[\w-]*):iam::(\d{12}):role\/[\w+=,.@/-]{1,512}$/;

/** Returns the 12-digit account ID, or null if this isn't an IAM role ARN. */
export function parseRoleArn(arn: string): { accountId: string; partition: string } | null {
  const m = arn.trim().match(ROLE_ARN_RE);
  return m ? { partition: m[1]!, accountId: m[2]! } : null;
}

/**
 * CloudFormation template the customer deploys in their AWS account. It
 * creates one IAM role that:
 *  - only CommitCost's own AWS principal can assume,
 *  - only when it presents this workspace's external ID, and
 *  - can only read Cost Explorer data.
 * The template is the same for every customer; the principal and external ID
 * arrive as parameters, so it can be hosted once in S3.
 */
export function cloudFormationTemplate(defaults: { principalArn?: string | null; externalId?: string } = {}): object {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "CommitCost read-only access to AWS Cost Explorer. Creates one IAM role; no access keys.",
    Parameters: {
      CommitCostPrincipalArn: {
        Type: "String",
        Description: "The CommitCost AWS principal allowed to assume this role. Provided by CommitCost.",
        AllowedPattern: "^arn:aws[\\w-]*:(iam|sts)::\\d{12}:.+$",
        ...(defaults.principalArn ? { Default: defaults.principalArn } : {}),
      },
      ExternalId: {
        Type: "String",
        Description: "Your CommitCost workspace's external ID. Shown on the Connect AWS page.",
        MinLength: 8,
        MaxLength: 1224,
        AllowedPattern: "^[\\w+=,.@:/-]+$",
        NoEcho: false,
        ...(defaults.externalId ? { Default: defaults.externalId } : {}),
      },
      RoleName: {
        Type: "String",
        Default: DEFAULT_ROLE_NAME,
        Description: "Name of the IAM role to create.",
      },
    },
    Resources: {
      CommitCostRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: { Ref: "RoleName" },
          Description: "Lets CommitCost read daily costs from Cost Explorer. Read-only.",
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { AWS: { Ref: "CommitCostPrincipalArn" } },
                Action: "sts:AssumeRole",
                Condition: { StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } },
              },
            ],
          },
          Policies: [
            {
              PolicyName: "CommitCostCostExplorerReadOnly",
              PolicyDocument: {
                Version: "2012-10-17",
                // Cost Explorer has no resource-level permissions, so "*" is required.
                Statement: [{ Effect: "Allow", Action: [...READ_ONLY_ACTIONS], Resource: "*" }],
              },
            },
          ],
        },
      },
    },
    Outputs: {
      RoleArn: {
        Description: "Paste this into CommitCost.",
        Value: { "Fn::GetAtt": ["CommitCostRole", "Arn"] },
      },
    },
  };
}

/**
 * AWS console link that opens the stack with the parameters filled in.
 * CloudFormation's quick-create only accepts templates hosted in S3, so this
 * needs `templateUrl`; without it the customer downloads and uploads the file.
 */
export function quickCreateUrl(opts: { templateUrl: string; principalArn: string; externalId: string; region?: string; stackName?: string }): string {
  const region = opts.region ?? "us-east-1";
  const q = new URLSearchParams({
    templateURL: opts.templateUrl,
    stackName: opts.stackName ?? "CommitCost",
    param_CommitCostPrincipalArn: opts.principalArn,
    param_ExternalId: opts.externalId,
  });
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${q}`;
}

export interface StsLike {
  send(command: AssumeRoleCommand): Promise<{ Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date } }>;
}

export interface AwsDeps {
  /** STS client using CommitCost's own credentials (standard AWS chain). */
  sts?: StsLike;
  /** Builds a Cost Explorer client from temporary credentials. Tests replace it. */
  costExplorer?: (credentials: AssumedCredentials) => CostExplorerLike;
}

export interface AssumedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

// Cost Explorer and IAM are global; STS works from any region, us-east-1 is the default.
const defaultSts = () => new STSClient({ region: process.env.AWS_REGION || "us-east-1" });
const defaultCostExplorer = (credentials: AssumedCredentials): CostExplorerLike => new CostExplorerClient({ region: "us-east-1", credentials });

/** Temporary credentials for the customer's role (15 minutes). Nothing long-lived exists. */
export async function assumeCustomerRole(roleArn: string, externalId: string | undefined, sessionName: string, deps: AwsDeps = {}): Promise<AssumedCredentials> {
  const sts = deps.sts ?? defaultSts();
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName.replace(/[^\w+=,.@-]/g, "-").slice(0, 64),
      DurationSeconds: 900,
      ...(externalId ? { ExternalId: externalId } : {}),
    }),
  );
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error("AWS STS returned no credentials");
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
}

/** A Cost Explorer client acting as the customer's read-only role. */
export async function costExplorerForRole(roleArn: string, externalId: string, sessionName: string, deps: AwsDeps = {}): Promise<CostExplorerLike> {
  const creds = await assumeCustomerRole(roleArn, externalId, sessionName, deps);
  return (deps.costExplorer ?? defaultCostExplorer)(creds);
}

export type VerifyResult = { ok: true; accountId: string } | { ok: false; error: string };

function errName(err: unknown): string {
  return (err as { name?: string })?.name ?? "";
}
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Checks a role before saving it:
 *  1. CommitCost can assume it with the workspace's external ID.
 *  2. It can NOT be assumed without the external ID. A role that skips that
 *     condition could be claimed by any CommitCost customer, so it's refused.
 *  3. It can read Cost Explorer (one small request, about $0.01).
 */
export async function verifyCustomerRole(roleArn: string, externalId: string, sessionName: string, deps: AwsDeps = {}, today = toIsoDate(new Date())): Promise<VerifyResult> {
  const parsed = parseRoleArn(roleArn);
  if (!parsed) return { ok: false, error: "That doesn't look like an IAM role ARN. It should look like arn:aws:iam::123456789012:role/CommitCostReadOnly." };

  let creds: AssumedCredentials;
  try {
    creds = await assumeCustomerRole(roleArn, externalId, sessionName, deps);
  } catch (err) {
    if (errName(err) === "AccessDenied" || /not authorized to perform: sts:AssumeRole/i.test(errMessage(err))) {
      return {
        ok: false,
        error:
          "CommitCost couldn't assume this role. Check that the CloudFormation stack finished (CREATE_COMPLETE), that you copied the RoleArn output, and that the stack used this workspace's external ID.",
      };
    }
    return { ok: false, error: `AWS rejected the role: ${errMessage(err)}` };
  }

  try {
    await assumeCustomerRole(roleArn, undefined, `${sessionName}-check`, deps);
    return {
      ok: false,
      error: "This role can be assumed without the external ID. Its trust policy must require sts:ExternalId; redeploy it from the CommitCost template.",
    };
  } catch {
    // Expected: the trust policy requires the external ID.
  }

  try {
    const ce = (deps.costExplorer ?? defaultCostExplorer)(creds);
    await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: addDays(today, -2), End: today },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
      }),
    );
  } catch (err) {
    const name = errName(err);
    if (name === "AccessDeniedException") {
      return { ok: false, error: "The role was assumed but can't read Cost Explorer. Make sure its policy allows ce:GetCostAndUsage." };
    }
    if (name === "DataUnavailableException" || /not enabled for cost explorer/i.test(errMessage(err))) {
      return {
        ok: false,
        error: "Cost Explorer isn't enabled for this account yet. Open Billing → Cost Explorer once to enable it (AWS takes up to 24 hours to prepare data), then try again.",
      };
    }
    return { ok: false, error: `Cost Explorer check failed: ${errMessage(err)}` };
  }

  return { ok: true, accountId: parsed.accountId };
}
