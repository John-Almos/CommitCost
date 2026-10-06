import { GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it } from "vitest";
import { cloudFormationTemplate, parseRoleArn, quickCreateUrl, READ_ONLY_ACTIONS, verifyCustomerRole, type AwsDeps } from "./aws.js";

const ROLE = "arn:aws:iam::111122223333:role/CommitCostReadOnly";
const EXT = "cc-external-id-123";

function awsError(name: string, message = name) {
  return Object.assign(new Error(message), { name });
}

/** Fake STS that enforces a trust policy, and a fake Cost Explorer. */
function fakeAws(opts: { requireExternalId?: boolean; trusted?: boolean; ceError?: Error } = {}) {
  const assumed: { RoleArn?: string; ExternalId?: string; RoleSessionName?: string }[] = [];
  const ceCalls: unknown[] = [];
  const deps: AwsDeps = {
    sts: {
      async send(cmd: AssumeRoleCommand) {
        assumed.push(cmd.input);
        if (opts.trusted === false) throw awsError("AccessDenied", "User: arn:aws:sts::999:assumed-role/cc is not authorized to perform: sts:AssumeRole");
        if ((opts.requireExternalId ?? true) && cmd.input.ExternalId !== EXT) throw awsError("AccessDenied");
        return { Credentials: { AccessKeyId: "ASIA", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date() } };
      },
    },
    costExplorer: (creds) => ({
      async send(cmd: GetCostAndUsageCommand) {
        ceCalls.push({ creds, input: cmd.input });
        if (opts.ceError) throw opts.ceError;
        return { ResultsByTime: [], $metadata: {} };
      },
    }),
  };
  return { deps, assumed, ceCalls };
}

describe("parseRoleArn", () => {
  it("extracts the account and rejects other ARNs", () => {
    expect(parseRoleArn(ROLE)).toEqual({ partition: "aws", accountId: "111122223333" });
    expect(parseRoleArn(" arn:aws-us-gov:iam::111122223333:role/path/Name ")?.accountId).toBe("111122223333");
    expect(parseRoleArn("arn:aws:iam::111122223333:user/bob")).toBeNull();
    expect(parseRoleArn("arn:aws:iam::1111:role/x")).toBeNull();
  });
});

describe("cloudFormationTemplate", () => {
  const t = cloudFormationTemplate({ principalArn: "arn:aws:iam::999988887777:role/commitcost" }) as any;
  const role = t.Resources.CommitCostRole.Properties;

  it("trusts only the CommitCost principal, and only with the external ID", () => {
    const [stmt] = role.AssumeRolePolicyDocument.Statement;
    expect(stmt.Principal).toEqual({ AWS: { Ref: "CommitCostPrincipalArn" } });
    expect(stmt.Condition).toEqual({ StringEquals: { "sts:ExternalId": { Ref: "ExternalId" } } });
    expect(role.AssumeRolePolicyDocument.Statement).toHaveLength(1);
    expect(t.Parameters.CommitCostPrincipalArn.Default).toBe("arn:aws:iam::999988887777:role/commitcost");
  });

  it("grants read-only Cost Explorer access and nothing else", () => {
    const statements = role.Policies.flatMap((p: any) => p.PolicyDocument.Statement);
    const actions = statements.flatMap((s: any) => s.Action);
    expect(actions).toEqual([...READ_ONLY_ACTIONS]);
    expect(actions.every((a: string) => /^ce:(Get|Describe|List)/.test(a))).toBe(true);
    expect(statements.every((s: any) => s.Effect === "Allow")).toBe(true);
    expect(role.ManagedPolicyArns).toBeUndefined();
    expect(JSON.stringify(t)).not.toMatch(/AccessKey/);
  });

  it("outputs the role ARN", () => {
    expect(t.Outputs.RoleArn.Value).toEqual({ "Fn::GetAtt": ["CommitCostRole", "Arn"] });
  });
});

describe("quickCreateUrl", () => {
  it("pre-fills the stack parameters", () => {
    const url = new URL(quickCreateUrl({ templateUrl: "https://s3.amazonaws.com/b/t.json", principalArn: "arn:aws:iam::999988887777:role/cc", externalId: EXT }));
    expect(url.hostname).toBe("us-east-1.console.aws.amazon.com");
    const params = new URLSearchParams(url.hash.split("?")[1]);
    expect(params.get("templateURL")).toBe("https://s3.amazonaws.com/b/t.json");
    expect(params.get("param_ExternalId")).toBe(EXT);
    expect(params.get("param_CommitCostPrincipalArn")).toBe("arn:aws:iam::999988887777:role/cc");
  });
});

describe("verifyCustomerRole", () => {
  it("accepts a correctly configured role", async () => {
    const { deps, assumed, ceCalls } = fakeAws();
    expect(await verifyCustomerRole(ROLE, EXT, "commitcost-acme", deps, "2026-10-06")).toEqual({ ok: true, accountId: "111122223333" });
    expect(assumed[0]).toMatchObject({ RoleArn: ROLE, ExternalId: EXT, RoleSessionName: "commitcost-acme" });
    expect(assumed[1]?.ExternalId).toBeUndefined();
    expect(ceCalls).toHaveLength(1);
  });

  it("rejects a role that doesn't require the external ID", async () => {
    const res = await verifyCustomerRole(ROLE, EXT, "s", fakeAws({ requireExternalId: false }).deps);
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/without the external ID/) });
  });

  it("explains a role CommitCost can't assume", async () => {
    const res = await verifyCustomerRole(ROLE, EXT, "s", fakeAws({ trusted: false }).deps);
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/couldn't assume this role/) });
  });

  it("explains missing Cost Explorer permission or setup", async () => {
    const denied = await verifyCustomerRole(ROLE, EXT, "s", fakeAws({ ceError: awsError("AccessDeniedException") }).deps);
    expect(denied).toMatchObject({ ok: false, error: expect.stringMatching(/ce:GetCostAndUsage/) });
    const disabled = await verifyCustomerRole(ROLE, EXT, "s", fakeAws({ ceError: awsError("DataUnavailableException") }).deps);
    expect(disabled).toMatchObject({ ok: false, error: expect.stringMatching(/isn't enabled/) });
  });

  it("rejects malformed ARNs before calling AWS", async () => {
    const { deps, assumed } = fakeAws();
    expect((await verifyCustomerRole("arn:aws:iam::1:user/x", EXT, "s", deps)).ok).toBe(false);
    expect(assumed).toHaveLength(0);
  });
});
