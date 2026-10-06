import Link from "next/link";
import type { SyncRun } from "@commitcost/db";
import type { SetupState } from "@/lib/setup";

function Step({ n, done, title, children, href, cta }: { n: number; done: boolean; title: string; children: React.ReactNode; href?: string; cta?: string }) {
  return (
    <li className={`step${done ? " done" : ""}`}>
      <span className="step-n" aria-hidden>
        {done ? "✓" : n}
      </span>
      <div className="step-body">
        <div className="row">
          <strong>{title}</strong>
          {href && cta && (
            <Link className={`button${done ? " secondary" : ""}`} href={href}>
              {cta}
            </Link>
          )}
        </div>
        <div className="ink2">{children}</div>
      </div>
    </li>
  );
}

/** The three steps from a new workspace to attributed cost changes. */
export function SetupChecklist({ state, canEdit }: { state: SetupState; canEdit: boolean }) {
  const synced = Boolean(state.lastSuccess);
  return (
    <ol className="steps">
      <Step n={1} done={state.awsDone} title="Connect AWS" href={canEdit ? "/settings/aws" : undefined} cta={state.awsDone ? "Manage" : "Connect"}>
        {state.awsDone
          ? `${state.aws.length} account${state.aws.length === 1 ? "" : "s"} connected through a read-only IAM role.`
          : "Create a read-only IAM role with one CloudFormation stack. CommitCost never sees AWS keys."}
      </Step>
      <Step n={2} done={state.githubDone} title="Connect GitHub" href={canEdit ? "/settings/github" : undefined} cta={state.githubDone ? "Manage" : "Connect"}>
        {state.githubDone
          ? `Tracking ${state.repos.map((r) => r.fullName).join(", ")}.`
          : "Install the CommitCost GitHub App on the repos that deploy to this AWS account. Read-only."}
      </Step>
      <Step n={3} done={synced} title="First sync">
        {synced
          ? "Costs and merged changes are in. CommitCost re-syncs on a schedule."
          : state.syncing
            ? "Syncing now. The first pull covers 90 days and can take a few minutes."
            : "Starts automatically once AWS and GitHub are connected."}
      </Step>
    </ol>
  );
}

const STATUS: Record<string, string> = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed" };

export function RunStatus({ run }: { run: SyncRun }) {
  return <span className={`status status-${run.status}`}>{STATUS[run.status] ?? run.status}</span>;
}
