import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { requireWorkspace } from "@/lib/auth";
import { db } from "@/lib/db";
import { isLocalMode } from "@/lib/platform";
import { inviteMember, removeMember, revokeInvite, setRole } from "../actions";

export const dynamic = "force-dynamic";

export default async function Members() {
  const { org, role, user } = await requireWorkspace();
  if (org.isDemo) return <div className="card empty">Everyone can view the demo workspace.</div>;
  const isOwner = role === "owner";
  const [members, invites] = await Promise.all([
    db.membership.findMany({ where: { orgId: org.id }, include: { user: true }, orderBy: { createdAt: "asc" } }),
    db.invite.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" } }),
  ]);

  return (
    <>
      <div className="card">
        <h2>Members</h2>
        <table>
          <thead>
            <tr>
              <th>GitHub user</th>
              <th>Role</th>
              {isOwner && <th />}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="mono">@{m.user.login}</span>
                  {m.userId === user.id && <span className="muted"> (you)</span>}
                </td>
                <td>
                  {isOwner ? (
                    <form action={setRole} className="inline-form">
                      <input type="hidden" name="id" value={m.id} />
                      <select name="role" defaultValue={m.role} aria-label={`Role for ${m.user.login}`}>
                        <option value="owner">Owner</option>
                        <option value="member">Member</option>
                      </select>
                      <SubmitButton className="link-button" pending="…">
                        Save
                      </SubmitButton>
                    </form>
                  ) : m.role === "owner" ? (
                    "Owner"
                  ) : (
                    "Member"
                  )}
                </td>
                {isOwner && (
                  <td className="num">
                    <form action={removeMember}>
                      <input type="hidden" name="id" value={m.id} />
                      <SubmitButton className="link-button" pending="Removing…">
                        {m.userId === user.id ? "Leave" : "Remove"}
                      </SubmitButton>
                    </form>
                  </td>
                )}
              </tr>
            ))}
            {invites.map((i) => (
              <tr key={i.id}>
                <td>
                  <span className="mono">@{i.githubLogin}</span> <span className="muted">invited</span>
                </td>
                <td>{i.role === "owner" ? "Owner" : "Member"}</td>
                {isOwner && (
                  <td className="num">
                    <form action={revokeInvite}>
                      <input type="hidden" name="id" value={i.id} />
                      <SubmitButton className="link-button" pending="…">
                        Revoke
                      </SubmitButton>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted fine">Owners manage connections and people. Members can view everything and start a sync.</p>
      </div>
      {isOwner && !isLocalMode() && (
        <div className="card">
          <h2>Invite a teammate</h2>
          <ActionForm action={inviteMember} submit="Invite" pending="Inviting…" className="form form-inline">
            <label className="field">
              <span>GitHub username</span>
              <input name="login" required placeholder="octocat" autoComplete="off" />
            </label>
          </ActionForm>
        </div>
      )}
    </>
  );
}
