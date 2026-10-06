import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { RunStatus, SetupChecklist } from "@/components/Setup";
import { requireWorkspace } from "@/lib/auth";
import { isLocalMode, platform } from "@/lib/platform";
import { getSetupState } from "@/lib/setup";
import { deleteWorkspace, syncNow } from "./actions";

export const dynamic = "force-dynamic";

const when = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "–");

export default async function SettingsOverview() {
  const { org, role } = await requireWorkspace();
  if (org.isDemo) {
    return (
      <div className="card">
        <h2>Connect your own company</h2>
        <p className="ink2">Create a workspace, then connect your AWS account and GitHub repos. It takes about five minutes, and CommitCost only ever gets read access.</p>
        <Link className="button" href="/onboarding">
          Create a workspace
        </Link>
      </div>
    );
  }
  const state = await getSetupState(org.id);
  const isOwner = role === "owner";
  const ready = state.awsDone && state.githubDone;

  return (
    <>
      <div className="card">
        <h2>Setup</h2>
        <SetupChecklist state={state} canEdit={isOwner} />
      </div>

      <div className="card">
        <div className="row">
          <h2>Sync</h2>
          {ready && (
            <form action={syncNow}>
              <SubmitButton className="button secondary" pending="Queuing…">
                Sync now
              </SubmitButton>
            </form>
          )}
        </div>
        <p className="ink2" style={{ marginTop: 0 }}>
          CommitCost pulls new costs and merged changes every {platform().sync.intervalHours} hours and re-runs attribution.
          {state.lastSuccess && ` Last successful sync: ${when(state.lastSuccess.finishedAt)}.`}
        </p>
        {state.runs.length === 0 ? (
          <div className="empty">{ready ? "No syncs yet." : "Connect AWS and GitHub to start syncing."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Trigger</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {state.runs.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{when(r.startedAt ?? r.queuedAt)}</td>
                  <td>{r.trigger}</td>
                  <td>
                    <RunStatus run={r} />
                  </td>
                  <td>
                    {r.error && <div className="up-bad">{r.error.split("\n")[0]}</div>}
                    {r.log ? (
                      <details>
                        <summary>Log</summary>
                        <pre className="log">{r.log}</pre>
                      </details>
                    ) : r.status === "queued" ? (
                      <span className="muted">Waiting for a worker{isLocalMode() ? " (run npm run worker)" : ""}.</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isOwner && (
        <div className="card danger">
          <h2>Delete workspace</h2>
          <p className="ink2">
            Removes {org.name}, its connections and all synced data from CommitCost. It doesn&apos;t touch anything in AWS or GitHub; delete the CloudFormation stack and uninstall the GitHub App there.
          </p>
          <ActionForm action={deleteWorkspace} submit="Delete workspace" pending="Deleting…" submitClassName="button danger-button">
            <label className="field">
              <span>
                Type <strong>{org.name}</strong> to confirm
              </span>
              <input name="confirm" autoComplete="off" />
            </label>
          </ActionForm>
        </div>
      )}
    </>
  );
}
