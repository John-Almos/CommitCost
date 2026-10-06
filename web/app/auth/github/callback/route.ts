import { claimInvites } from "@commitcost/db";
import { NextResponse, type NextRequest } from "next/server";
import { currentUser, selectWorkspace, startSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { attachInstallation } from "@/lib/github";
import { consumeOAuthState } from "@/lib/oauth";
import { githubApp, platform } from "@/lib/platform";

export const dynamic = "force-dynamic";

const to = (path: string) => NextResponse.redirect(new URL(path, platform().appUrl));

export async function GET(req: NextRequest) {
  const app = githubApp();
  if (!app) return to("/");
  const q = req.nextUrl.searchParams;
  const state = await consumeOAuthState(q.get("state"));
  if (q.get("error") === "access_denied") return to(state?.purpose === "install" ? "/settings/github?error=denied" : "/login?error=denied");
  if (!state) return to("/login?error=state");
  const code = q.get("code");
  if (!code) return to("/login?error=github");

  let userToken: string;
  try {
    userToken = await app.exchangeCode(code, `${platform().appUrl}/auth/github/callback`);
  } catch {
    return to(state.purpose === "install" ? "/settings/github?error=github" : "/login?error=github");
  }

  if (state.purpose === "install") {
    // Must be the same signed-in user who started the install.
    const user = await currentUser();
    if (!user || user.id !== state.userId) return to("/login?error=state");
    const result = await attachInstallation({ userToken, orgId: state.orgId, userId: user.id, installationId: state.installationId });
    return to(result.ok ? "/settings/github?connected=1" : `/settings/github?error=${result.error}`);
  }

  // Sign-in. The user token is only used here to read the profile; it isn't stored.
  const gh = await app.getUser(userToken);
  const user = await db.user.upsert({
    where: { githubId: gh.id },
    create: { githubId: gh.id, login: gh.login, name: gh.name, avatarUrl: gh.avatar_url },
    update: { login: gh.login, name: gh.name, avatarUrl: gh.avatar_url },
  });
  await claimInvites(db, user.id, gh.login);
  await startSession(user.id);
  const first = await db.membership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  if (!first) return to("/onboarding");
  await selectWorkspace(first.orgId);
  return to(state.next);
}
