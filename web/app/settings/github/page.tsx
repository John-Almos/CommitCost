import type { InstallationRepo } from "@commitcost/platform";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { requireWorkspace } from "@/lib/auth";
import { db } from "@/lib/db";
import { githubApp, platform } from "@/lib/platform";
import { disconnectInstallation, saveRepos } from "../actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "not-yours": "Your GitHub account can't access that installation, so it wasn't connected.",
  taken: "That GitHub installation is already connected to another CommitCost workspace.",
  forbidden: "Only workspace owners can connect GitHub.",
  denied: "GitHub authorization was cancelled.",
  github: "GitHub didn't respond as expected. Please try again.",
  unconfigured: "This CommitCost server has no GitHub App configured.",
};

export default async function GitHubSettings({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string; requested?: string }> }) {
  const { org, role } = await requireWorkspace();
  if (org.isDemo) return <div className="card empty">The demo workspace has no GitHub connection.</div>;
  const q = await searchParams;
  const isOwner = role === "owner";
  const app = githubApp();
  const [installations, tracked] = await Promise.all([
    db.gitHubInstallation.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" } }),
    db.trackedRepo.findMany({ where: { orgId: org.id } }),
  ]);
  const trackedIds = new Set(tracked.map((t) => t.githubRepoId));

  // Live list of what each installation can read, for the picker.
  const available: { inst: (typeof installations)[number]; repos: InstallationRepo[]; error?: string }[] = [];
  for (const inst of installations) {
    if (!app || inst.suspended) {
      available.push({ inst, repos: [], error: inst.suspended ? "This installation is suspended on GitHub." : undefined });
      continue;
    }
    try {
      available.push({ inst, repos: await app.listInstallationRepos(inst.installationId) });
    } catch (err) {
      available.push({ inst, repos: [], error: `Couldn't list repositories: ${err instanceof Error ? err.message : err}` });
    }
  }
  const manageUrl = (i: { accountType: string; accountLogin: string; installationId: number }) =>
    i.accountType === "Organization"
      ? `${platform().github?.webUrl ?? "https://github.com"}/organizations/${i.accountLogin}/settings/installations/${i.installationId}`
      : `${platform().github?.webUrl ?? "https://github.com"}/settings/installations/${i.installationId}`;

  return (
    <>
      {q.error && <div className="callout error-callout">{ERRORS[q.error] ?? ERRORS.github}</div>}
      {q.connected && <div className="callout ok-callout">GitHub connected. Pick the repositories to track below.</div>}
      {q.requested && <div className="callout">Your request to install the app was sent to the GitHub organization&apos;s owners. Come back here once they approve it.</div>}

      <div className="card">
        <div className="row">
          <h2>GitHub</h2>
          {isOwner && app && (
            <a className={`button${installations.length ? " secondary" : ""}`} href="/github/install">
              {installations.length ? "Add another GitHub account" : "Connect GitHub"}
            </a>
          )}
        </div>
        <p className="ink2" style={{ marginTop: 0 }}>
          CommitCost reads merged pull requests and their diffs through a GitHub App with read-only access to contents, pull requests and metadata. You choose
          which repositories it can see when you install it, and you can change that on GitHub at any time.
        </p>
        {!app && <div className="callout error-callout">{ERRORS.unconfigured}</div>}
        {installations.length === 0 && app && <div className="empty">Not connected yet.</div>}
      </div>

      {available.map(({ inst, repos, error }) => (
        <div className="card" key={inst.id}>
          <div className="row">
            <h2>
              {inst.accountType === "Organization" ? "Organization" : "User"} <span className="mono">{inst.accountLogin}</span>
            </h2>
            <span>
              <a className="link-button" href={manageUrl(inst)} target="_blank" rel="noreferrer">
                Change repository access on GitHub
              </a>
            </span>
          </div>
          {error && <div className="callout error-callout">{error}</div>}
          {isOwner && repos.length > 0 && (
            <ActionForm action={saveRepos} submit="Save tracked repositories" pending="Saving…">
              <p className="ink2" style={{ margin: 0 }}>
                Track the repositories whose deploys can change this workspace&apos;s AWS bill.
              </p>
              {/* Keep other installations' choices when saving this one. */}
              {tracked
                .filter((t) => t.installationId !== inst.id)
                .map((t) => (
                  <input key={t.id} type="hidden" name="repo" value={t.githubRepoId} />
                ))}
              <div className="repo-list">
                {repos.map((r) => (
                  <label key={r.id} className="check">
                    <input type="checkbox" name="repo" value={r.id} defaultChecked={trackedIds.has(r.id)} />
                    <span className="mono">{r.full_name}</span>
                    <span className="muted">
                      {r.private ? "private" : "public"} · {r.default_branch}
                    </span>
                  </label>
                ))}
              </div>
            </ActionForm>
          )}
          {!isOwner && (
            <ul className="list">
              {tracked
                .filter((t) => t.installationId === inst.id)
                .map((t) => (
                  <li key={t.id} className="mono">
                    {t.fullName}
                  </li>
                ))}
            </ul>
          )}
          {isOwner && (
            <form action={disconnectInstallation} style={{ marginTop: 12 }}>
              <input type="hidden" name="id" value={inst.id} />
              <SubmitButton className="link-button" pending="Disconnecting…">
                Disconnect from this workspace
              </SubmitButton>
              <span className="muted"> Stops syncing. To revoke access entirely, also uninstall the app on GitHub.</span>
            </form>
          )}
        </div>
      ))}
    </>
  );
}
