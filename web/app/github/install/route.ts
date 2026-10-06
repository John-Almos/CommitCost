import { signState } from "@commitcost/platform";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { githubApp, platform } from "@/lib/platform";

export const dynamic = "force-dynamic";

/** "Connect GitHub": sends an owner to install the CommitCost GitHub App. */
export async function GET() {
  const app = githubApp();
  if (!app) return NextResponse.redirect(new URL("/settings/github?error=unconfigured", platform().appUrl));
  const ws = await requireOwner();
  const state = signState({ purpose: "install-start", orgId: ws.org.id, userId: ws.user.id }, platform().secret, 60 * 60_000);
  return NextResponse.redirect(app.installUrl(state));
}
