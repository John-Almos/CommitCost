import { verifyState } from "@commitcost/platform";
import { NextResponse, type NextRequest } from "next/server";
import { currentWorkspace, currentUser } from "@/lib/auth";
import { oauthRedirect } from "@/lib/oauth";
import { githubApp, platform } from "@/lib/platform";

export const dynamic = "force-dynamic";

const to = (path: string) => NextResponse.redirect(new URL(path, platform().appUrl));

/**
 * The GitHub App's "Setup URL". GitHub sends the browser here after an
 * install or a change of repository access. The installation ID in the query
 * is unverified, so we bounce through OAuth to confirm the signed-in user can
 * really access it before linking it.
 */
export async function GET(req: NextRequest) {
  if (!githubApp()) return to("/");
  const q = req.nextUrl.searchParams;
  if (q.get("setup_action") === "request") return to("/settings/github?requested=1");
  const installationId = Number(q.get("installation_id"));
  if (!Number.isInteger(installationId) || installationId <= 0) return to("/settings/github?error=github");

  const user = await currentUser();
  if (!user) return to(`/login?next=${encodeURIComponent(`/github/setup?${q}`)}`);

  // Started from CommitCost: the signed state names the workspace. Started
  // from GitHub (e.g. "Configure" on an existing install): use the current one.
  const started = verifyState<{ purpose: string; orgId: string; userId: string }>(q.get("state"), platform().secret);
  let orgId: string | undefined;
  if (started?.purpose === "install-start" && started.userId === user.id) orgId = started.orgId;
  else orgId = (await currentWorkspace())?.org.id;
  if (!orgId) return to("/onboarding");

  return NextResponse.redirect(await oauthRedirect({ purpose: "install", orgId, userId: user.id, installationId }));
}
