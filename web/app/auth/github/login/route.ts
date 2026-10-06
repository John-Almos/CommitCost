import { NextResponse, type NextRequest } from "next/server";
import { oauthRedirect, safeNext } from "@/lib/oauth";
import { githubApp, platform } from "@/lib/platform";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!githubApp()) return NextResponse.redirect(new URL("/", platform().appUrl));
  return NextResponse.redirect(await oauthRedirect({ purpose: "login", next: safeNext(req.nextUrl.searchParams.get("next")) }));
}
