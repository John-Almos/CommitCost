import { verifyWebhookSignature } from "@commitcost/platform";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { platform } from "@/lib/platform";

export const dynamic = "force-dynamic";

interface InstallationEvent {
  action: string;
  installation: { id: number };
  repositories_removed?: { full_name: string }[];
}

/** GitHub App webhook: keeps installations and tracked repos in step with GitHub. */
export async function POST(req: NextRequest) {
  const secret = platform().github?.webhookSecret;
  if (!secret) return NextResponse.json({ error: "Webhooks are not configured" }, { status: 404 });
  const body = await req.text();
  if (!verifyWebhookSignature(body, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }
  const event = req.headers.get("x-github-event");
  const payload = JSON.parse(body) as InstallationEvent;
  const installationId = payload.installation?.id;
  if (!installationId) return NextResponse.json({ ok: true, ignored: true });

  if (event === "installation") {
    if (payload.action === "deleted") {
      // Cascades to the installation's tracked repos. Synced history is kept.
      await db.gitHubInstallation.deleteMany({ where: { installationId } });
    } else if (payload.action === "suspend" || payload.action === "unsuspend") {
      await db.gitHubInstallation.updateMany({ where: { installationId }, data: { suspended: payload.action === "suspend" } });
    }
  } else if (event === "installation_repositories" && payload.repositories_removed?.length) {
    const inst = await db.gitHubInstallation.findUnique({ where: { installationId } });
    if (inst) {
      await db.trackedRepo.deleteMany({ where: { installationId: inst.id, fullName: { in: payload.repositories_removed.map((r) => r.full_name) } } });
    }
  }
  return NextResponse.json({ ok: true });
}
