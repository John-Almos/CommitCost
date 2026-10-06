"use server";

import { redirect } from "next/navigation";
import { currentWorkspace, endSession, requireUser, selectWorkspace } from "@/lib/auth";

export async function switchWorkspace(form: FormData): Promise<void> {
  await requireUser();
  const ws = await currentWorkspace();
  const id = String(form.get("orgId") ?? "");
  // Only switch to a workspace the user can actually see.
  if (ws?.all.some((o) => o.id === id)) await selectWorkspace(id);
  redirect("/");
}

export async function signOut(): Promise<void> {
  await endSession();
  redirect("/login");
}
