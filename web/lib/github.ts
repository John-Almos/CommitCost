import { db } from "./db";
import { githubApp } from "./platform";

export type AttachError = "forbidden" | "not-yours" | "taken" | "github";

/**
 * Links a GitHub App installation to a workspace after checking that the
 * user is an owner of the workspace AND can access the installation on
 * GitHub. The installation ID arrives in a URL, so it is never trusted alone.
 */
export async function attachInstallation(opts: { userToken: string; orgId: string; userId: string; installationId: number }): Promise<{ ok: true } | { ok: false; error: AttachError }> {
  const app = githubApp();
  if (!app) return { ok: false, error: "github" };
  const member = await db.membership.findUnique({ where: { userId_orgId: { userId: opts.userId, orgId: opts.orgId } } });
  if (member?.role !== "owner") return { ok: false, error: "forbidden" };

  try {
    if (!(await app.userCanAccessInstallation(opts.userToken, opts.installationId))) return { ok: false, error: "not-yours" };
    const inst = await app.getInstallation(opts.installationId);
    const existing = await db.gitHubInstallation.findUnique({ where: { installationId: inst.id } });
    if (existing && existing.orgId !== opts.orgId) return { ok: false, error: "taken" };
    await db.gitHubInstallation.upsert({
      where: { installationId: inst.id },
      create: {
        orgId: opts.orgId,
        installationId: inst.id,
        accountLogin: inst.account?.login ?? "unknown",
        accountType: inst.account?.type ?? "User",
        suspended: Boolean(inst.suspended_at),
      },
      update: { accountLogin: inst.account?.login ?? "unknown", suspended: Boolean(inst.suspended_at) },
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "github" };
  }
}
