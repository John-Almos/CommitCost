import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { requireUser } from "@/lib/auth";
import { createWorkspace } from "../settings/actions";

export const dynamic = "force-dynamic";

export default async function Onboarding() {
  const user = await requireUser();
  return (
    <div className="auth-card card">
      <h1>Create a workspace</h1>
      <p className="sub">A workspace holds one company&apos;s AWS accounts, repositories and cost history. You can invite teammates after setup.</p>
      <ActionForm action={createWorkspace} submit="Create workspace" pending="Creating…">
        <label className="field">
          <span>Company or team name</span>
          <input name="name" required minLength={2} maxLength={80} placeholder="Acme Inc." autoFocus defaultValue={user.login === "local" ? "" : undefined} />
        </label>
      </ActionForm>
      <p className="muted fine">
        Just looking? <Link href="/">Explore the demo workspace</Link> with generated data first.
      </p>
    </div>
  );
}
