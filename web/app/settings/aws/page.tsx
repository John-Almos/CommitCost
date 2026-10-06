import { DEFAULT_ROLE_NAME, quickCreateUrl, READ_ONLY_ACTIONS } from "@commitcost/platform";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { CopyField } from "@/components/CopyField";
import { requireWorkspace } from "@/lib/auth";
import { db } from "@/lib/db";
import { platform } from "@/lib/platform";
import { connectAws, removeAws } from "../actions";

export const dynamic = "force-dynamic";

export default async function AwsSettings() {
  const { org, role } = await requireWorkspace();
  if (org.isDemo) return <div className="card empty">The demo workspace has no AWS connection.</div>;
  const isOwner = role === "owner";
  const connections = await db.awsConnection.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" } });
  const { principalArn, templateUrl } = platform().aws;
  const launch = principalArn && templateUrl ? quickCreateUrl({ templateUrl, principalArn, externalId: org.awsExternalId }) : null;

  return (
    <>
      {connections.length > 0 && (
        <div className="card">
          <h2>Connected accounts</h2>
          <ul className="list">
            {connections.map((c) => (
              <li key={c.id}>
                <div className="row">
                  <div>
                    <strong className="mono">{c.accountId}</strong>{" "}
                    <span className={`status status-${c.status === "active" ? "succeeded" : "failed"}`}>{c.status === "active" ? "Connected" : "Error"}</span>
                    <div className="muted mono">{c.roleArn}</div>
                    <div className="ink2">
                      {c.tagKey ? `Grouped by service and the "${c.tagKey}" cost-allocation tag` : "Grouped by service"} · {c.costMetric}
                    </div>
                    {c.lastError && <div className="up-bad">{c.lastError}</div>}
                  </div>
                  {isOwner && (
                    <form action={removeAws}>
                      <input type="hidden" name="id" value={c.id} />
                      <SubmitButton className="button secondary" pending="Removing…">
                        Disconnect
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isOwner ? (
        <div className="card">
          <h2>{connections.length ? "Connect another AWS account" : "Connect AWS"}</h2>
          <p className="ink2">
            CommitCost reads daily costs from Cost Explorer through an IAM role in your account. The role can only call{" "}
            {READ_ONLY_ACTIONS.map((a, i) => (
              <span key={a}>
                {i ? " and " : ""}
                <code>{a}</code>
              </span>
            ))}
            , only CommitCost can assume it, and only with your workspace&apos;s external ID. No access keys are created or shared. Connect the account
            that owns billing (your management account if you use AWS Organizations) to see costs for every linked account.
          </p>

          {!principalArn && (
            <div className="callout error-callout">
              This CommitCost server has no AWS principal configured (<code>COMMITCOST_AWS_PRINCIPAL_ARN</code>), so the template can&apos;t say who may
              assume the role. Ask your CommitCost administrator to set it.
            </div>
          )}
          <ol className="steps numbered">
            <li>
              <strong>Create the role.</strong>{" "}
              {launch ? (
                <>
                  <a className="button" href={launch} target="_blank" rel="noreferrer">
                    Launch stack in AWS
                  </a>{" "}
                  <span className="muted">Opens the CloudFormation console with everything filled in. Tick the IAM acknowledgement and click Create stack.</span>
                </>
              ) : (
                <>
                  <a className="button" href="/api/aws/template">
                    Download template
                  </a>{" "}
                  <span className="muted">
                    In the AWS console, open CloudFormation → Create stack → Upload a template file, choose this file, and create the stack. Your external ID is already filled in.
                  </span>
                </>
              )}
              <div className="kv" style={{ marginTop: 12 }}>
                <dt>External ID</dt>
                <dd>
                  <CopyField value={org.awsExternalId} />
                </dd>
                {principalArn && (
                  <>
                    <dt>Trusted principal</dt>
                    <dd>
                      <CopyField value={principalArn} />
                    </dd>
                  </>
                )}
              </div>
              <details style={{ marginTop: 10 }}>
                <summary>Prefer the AWS CLI?</summary>
                <pre className="log">{`aws cloudformation deploy \\
  --stack-name CommitCost \\
  --template-file commitcost-aws-role.json \\
  --capabilities CAPABILITY_NAMED_IAM \\
  --parameter-overrides ExternalId=${org.awsExternalId}${principalArn ? ` CommitCostPrincipalArn=${principalArn}` : ""}

aws cloudformation describe-stacks --stack-name CommitCost \\
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text`}</pre>
              </details>
            </li>
            <li>
              <strong>Paste the role ARN.</strong> When the stack shows CREATE_COMPLETE, copy <code>RoleArn</code> from its Outputs tab. CommitCost checks the role
              before saving it.
              <ActionForm action={connectAws} submit="Verify and connect" pending="Checking the role with AWS…">
                <label className="field">
                  <span>Role ARN</span>
                  <input name="roleArn" required placeholder={`arn:aws:iam::123456789012:role/${DEFAULT_ROLE_NAME}`} className="mono" />
                </label>
                <div className="grid-2">
                  <label className="field">
                    <span>
                      Cost-allocation tag <span className="muted">(optional)</span>
                    </span>
                    <input name="tagKey" placeholder="app" />
                    <small className="muted">Break costs down by a tag such as app or service. It must be activated in Billing → Cost allocation tags.</small>
                  </label>
                  <label className="field">
                    <span>Cost metric</span>
                    <select name="costMetric" defaultValue="UnblendedCost">
                      <option value="UnblendedCost">Unblended (default)</option>
                      <option value="AmortizedCost">Amortized (spreads RIs and Savings Plans)</option>
                      <option value="NetUnblendedCost">Net unblended (after discounts)</option>
                      <option value="NetAmortizedCost">Net amortized</option>
                    </select>
                  </label>
                </div>
              </ActionForm>
            </li>
          </ol>
        </div>
      ) : (
        <div className="card empty">Only workspace owners can connect AWS accounts.</div>
      )}
    </>
  );
}
