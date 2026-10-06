"use server";

import { createOrganization, enqueueSync } from "@commitcost/db";
import { parseRoleArn, verifyCustomerRole } from "@commitcost/platform";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMember, requireOwner, requireUser, selectWorkspace } from "@/lib/auth";
import { db } from "@/lib/db";
import { githubApp } from "@/lib/platform";

export interface FormResult {
  ok?: boolean;
  error?: string;
  message?: string;
}

const COST_METRICS = ["UnblendedCost", "AmortizedCost", "NetUnblendedCost", "NetAmortizedCost"];

export async function createWorkspace(_prev: FormResult | null, form: FormData): Promise<FormResult> {
  const user = await requireUser();
  const name = String(form.get("name") ?? "").trim();
  if (name.length < 2) return { error: "Give your workspace a name, like your company or team." };
  const org = await createOrganization(db, name, user.id);
  await selectWorkspace(org.id);
  redirect("/settings");
}

/** Verifies the customer's role (assume with external ID, refuse without it, read Cost Explorer), then saves it. */
export async function connectAws(_prev: FormResult | null, form: FormData): Promise<FormResult> {
  const { org } = await requireOwner();
  const roleArn = String(form.get("roleArn") ?? "").trim();
  const tagKey = String(form.get("tagKey") ?? "").trim();
  const costMetric = String(form.get("costMetric") ?? "UnblendedCost");
  if (!parseRoleArn(roleArn)) return { error: "Paste the RoleArn from the stack's Outputs tab. It looks like arn:aws:iam::123456789012:role/CommitCostReadOnly." };
  if (tagKey && !/^[\w.:/=+@ -]{1,128}$/.test(tagKey)) return { error: "That tag key has characters AWS doesn't allow." };
  if (!COST_METRICS.includes(costMetric)) return { error: "Unknown cost metric." };

  const result = await verifyCustomerRole(roleArn, org.awsExternalId, `commitcost-${org.slug}`);
  if (!result.ok) return { error: result.error };

  await db.awsConnection.upsert({
    where: { orgId_accountId: { orgId: org.id, accountId: result.accountId } },
    create: { orgId: org.id, accountId: result.accountId, roleArn, tagKey, costMetric, verifiedAt: new Date() },
    update: { roleArn, tagKey, costMetric, status: "active", lastError: null, verifiedAt: new Date() },
  });
  await enqueueSync(db, org.id, "connect");
  revalidatePath("/settings", "layout");
  return { ok: true, message: `Connected AWS account ${result.accountId}. The first sync is queued.` };
}

export async function removeAws(form: FormData): Promise<void> {
  const { org } = await requireOwner();
  // Scoped by org: an id from another workspace matches nothing.
  await db.awsConnection.deleteMany({ where: { id: String(form.get("id")), orgId: org.id } });
  revalidatePath("/settings", "layout");
}

/** Replaces the set of tracked repos. Choices are checked against what the installations can actually read. */
export async function saveRepos(_prev: FormResult | null, form: FormData): Promise<FormResult> {
  const { org } = await requireOwner();
  const app = githubApp();
  if (!app) return { error: "GitHub isn't configured on this server." };
  const wanted = new Set(form.getAll("repo").map(String));
  if (wanted.size > 50) return { error: "Pick up to 50 repositories." };

  const installations = await db.gitHubInstallation.findMany({ where: { orgId: org.id, suspended: false } });
  const chosen: { installationId: string; githubRepoId: number; fullName: string; defaultBranch: string }[] = [];
  try {
    for (const inst of installations) {
      for (const r of await app.listInstallationRepos(inst.installationId)) {
        if (wanted.has(String(r.id))) chosen.push({ installationId: inst.id, githubRepoId: r.id, fullName: r.full_name, defaultBranch: r.default_branch });
      }
    }
  } catch (err) {
    return { error: `Couldn't list repositories from GitHub: ${err instanceof Error ? err.message : err}` };
  }

  await db.$transaction([
    db.trackedRepo.deleteMany({ where: { orgId: org.id, fullName: { notIn: chosen.map((c) => c.fullName) } } }),
    ...chosen.map((c) =>
      db.trackedRepo.upsert({
        where: { orgId_fullName: { orgId: org.id, fullName: c.fullName } },
        create: { orgId: org.id, ...c },
        update: { installationId: c.installationId, githubRepoId: c.githubRepoId, defaultBranch: c.defaultBranch },
      }),
    ),
  ]);
  if (chosen.length) await enqueueSync(db, org.id, "connect");
  revalidatePath("/settings", "layout");
  return { ok: true, message: chosen.length ? `Tracking ${chosen.length} repo${chosen.length === 1 ? "" : "s"}. A sync is queued.` : "No repositories tracked." };
}

export async function disconnectInstallation(form: FormData): Promise<void> {
  const { org } = await requireOwner();
  await db.gitHubInstallation.deleteMany({ where: { id: String(form.get("id")), orgId: org.id } });
  revalidatePath("/settings", "layout");
}

export async function syncNow(): Promise<void> {
  const { org } = await requireMember();
  await enqueueSync(db, org.id, "manual");
  revalidatePath("/settings", "layout");
}

export async function inviteMember(_prev: FormResult | null, form: FormData): Promise<FormResult> {
  const { org, user } = await requireOwner();
  const typed = String(form.get("login") ?? "").trim().replace(/^@/, "");
  const login = typed.toLowerCase();
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/.test(login)) return { error: "Enter a GitHub username." };
  // GitHub logins are case-insensitive; stored logins keep GitHub's casing.
  const existing = await db.user.findFirst({ where: { login: { in: [typed, login] }, githubId: { gt: 0 } } });
  if (existing) {
    await db.membership.upsert({
      where: { userId_orgId: { userId: existing.id, orgId: org.id } },
      create: { userId: existing.id, orgId: org.id, role: "member" },
      update: {},
    });
  } else {
    await db.invite.upsert({
      where: { orgId_githubLogin: { orgId: org.id, githubLogin: login } },
      create: { orgId: org.id, githubLogin: login, invitedBy: user.id },
      update: {},
    });
  }
  revalidatePath("/settings/members");
  return { ok: true, message: existing ? `@${login} now has access.` : `@${login} gets access the next time they sign in with GitHub.` };
}

export async function removeMember(form: FormData): Promise<void> {
  const { org, user } = await requireOwner();
  const id = String(form.get("id"));
  const m = await db.membership.findFirst({ where: { id, orgId: org.id } });
  if (!m) return;
  if (m.role === "owner" && (await db.membership.count({ where: { orgId: org.id, role: "owner" } })) <= 1) {
    throw new Error("A workspace needs at least one owner.");
  }
  await db.membership.delete({ where: { id: m.id } });
  if (m.userId === user.id) redirect("/");
  revalidatePath("/settings/members");
}

export async function setRole(form: FormData): Promise<void> {
  const { org } = await requireOwner();
  const role = String(form.get("role"));
  if (role !== "owner" && role !== "member") return;
  const m = await db.membership.findFirst({ where: { id: String(form.get("id")), orgId: org.id } });
  if (!m) return;
  if (m.role === "owner" && role === "member" && (await db.membership.count({ where: { orgId: org.id, role: "owner" } })) <= 1) {
    throw new Error("A workspace needs at least one owner.");
  }
  await db.membership.update({ where: { id: m.id }, data: { role } });
  revalidatePath("/settings/members");
}

export async function revokeInvite(form: FormData): Promise<void> {
  const { org } = await requireOwner();
  await db.invite.deleteMany({ where: { id: String(form.get("id")), orgId: org.id } });
  revalidatePath("/settings/members");
}

/** Deletes the workspace and all its data. The typed name guards against slips. */
export async function deleteWorkspace(_prev: FormResult | null, form: FormData): Promise<FormResult> {
  const { org } = await requireOwner();
  if (String(form.get("confirm") ?? "").trim() !== org.name) return { error: `Type "${org.name}" to confirm.` };
  await db.organization.delete({ where: { id: org.id } });
  redirect("/");
}
