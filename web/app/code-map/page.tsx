import Link from "next/link";
import type { CodeCost } from "@commitcost/engine";
import { getCodeMap } from "@/lib/history";
import { SERVICE_NAMES, usd } from "@/lib/format";

export const dynamic = "force-dynamic";

const files = (n: number) => `across ${n} file${n === 1 ? "" : "s"}`;

/** Signed bar centered on zero: red right for added cost, green left for savings. */
function CostBar({ c, max }: { c: CodeCost; max: number }) {
  const w = (v: number) => `${(Math.min(Math.abs(v), max) / max) * 50}%`;
  return (
    <div className="costbar" aria-hidden>
      <div className="mid" />
      {c.increaseUsd > 0 && <div className="fill up" style={{ width: w(c.increaseUsd) }} />}
      {c.decreaseUsd < 0 && <div className="fill down" style={{ width: w(c.decreaseUsd) }} />}
    </div>
  );
}

function Changes({ c }: { c: CodeCost }) {
  return (
    <>
      {c.changes.map((x, i) => (
        <span key={x.commitSha}>
          {i > 0 && ", "}
          <Link href={x.anomalyIds[0] ? `/anomalies/${x.anomalyIds[0]}` : `/changes/${x.commitSha.slice(0, 12)}`}>
            {x.prNumber ? `#${x.prNumber}` : x.commitSha.slice(0, 7)} {usd(x.monthlyUsd, { sign: true })}
          </Link>
        </span>
      ))}
    </>
  );
}

export default async function CodeMapPage() {
  const { map, hasCodeowners } = await getCodeMap();
  const rows = [...map.dirs, ...map.files].sort((a, b) => a.path.localeCompare(b.path));
  const max = Math.max(1, ...rows.map((r) => Math.max(r.increaseUsd, -r.decreaseUsd)));
  const depth = (p: string) => p.replace(/\/$/, "").split("/").length - 1;
  const name = (p: string) => p.replace(/\/$/, "").split("/").pop() + (p.endsWith("/") ? "/" : "");
  const added = map.files.reduce((s, f) => s + f.increaseUsd, 0);
  const saved = map.files.reduce((s, f) => s + f.decreaseUsd, 0);

  return (
    <>
      <h1>Code cost map</h1>
      <p className="sub">
        The bill changes CommitCost traced to merged code, placed on the files that caused them and rolled up by directory and owner. It shows which parts of the codebase have added the most to the monthly bill, and who owns them.
      </p>

      {map.files.length === 0 ? (
        <div className="card empty">Nothing attributed yet. Run an analysis with cost changes that trace back to merged code.</div>
      ) : (
        <>
          <div className="grid-3" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="tile-label">Added by code changes</div>
              <div className="tile-value up-bad">{usd(added, { sign: true })}/mo</div>
              <div className="tile-delta">{files(map.files.filter((f) => f.increaseUsd > 0).length)}</div>
            </div>
            <div className="card">
              <div className="tile-label">Saved by code changes</div>
              <div className="tile-value down-good">{usd(saved, { sign: true })}/mo</div>
              <div className="tile-delta">{files(map.files.filter((f) => f.decreaseUsd < 0).length)}</div>
            </div>
            <div className="card">
              <div className="tile-label">Largest owner</div>
              <div className="tile-value" style={{ fontSize: 20 }}>
                {map.owners[0]?.owner ?? "—"}
              </div>
              <div className="tile-delta">{map.owners[0] ? `${usd(map.owners[0].monthlyUsd, { sign: true })}/mo net` : hasCodeowners ? "" : "No CODEOWNERS file found"}</div>
            </div>
          </div>

          <div className="layout-main">
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table className="tree">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: 20 }}>Path</th>
                    <th className="num">Net</th>
                    <th style={{ width: 180 }}>
                      <span className="up-bad">added</span> / <span className="down-good">saved</span>
                    </th>
                    <th style={{ paddingRight: 20 }}>Owners</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const dir = r.path.endsWith("/");
                    return (
                      <tr key={r.path}>
                        <td style={{ paddingLeft: 20 + depth(r.path) * 16 }}>
                          <span className={`path mono${dir ? " muted" : ""}`} title={r.path}>
                            {name(r.path)}
                          </span>
                          {!dir && (
                            <div className="muted" style={{ fontSize: 12 }}>
                              <Changes c={r} /> · {r.services.map((s) => SERVICE_NAMES[s] ?? s).join(", ")}
                            </div>
                          )}
                        </td>
                        <td className={`num ${r.monthlyUsd > 0 ? "up-bad" : r.monthlyUsd < 0 ? "down-good" : ""}`} style={{ fontWeight: dir ? 400 : 600 }}>
                          {usd(r.monthlyUsd, { sign: true })}/mo
                        </td>
                        <td>
                          <CostBar c={r} max={max} />
                        </td>
                        <td style={{ paddingRight: 20 }}>
                          <span className="owner">{r.owners.join(" ") || "—"}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <aside className="stack">
              <div className="card">
                <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>By owner</h3>
                {map.owners.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    {hasCodeowners ? "No CODEOWNERS rule covers the attributed files." : "Add a CODEOWNERS file to the repo and sync to see cost by team."}
                  </p>
                ) : (
                  <table>
                    <tbody>
                      {map.owners.map((o) => (
                        <tr key={o.owner}>
                          <td>
                            <strong>{o.owner}</strong>
                            <div className="muted" style={{ fontSize: 12 }}>
                              {o.files.length} file{o.files.length === 1 ? "" : "s"}
                              {o.decreaseUsd < 0 ? ` · ${usd(o.increaseUsd, { sign: true })} added, ${usd(o.decreaseUsd, { sign: true })} saved` : ""}
                            </div>
                          </td>
                          <td className={`num ${o.monthlyUsd > 0 ? "up-bad" : "down-good"}`}>{usd(o.monthlyUsd, { sign: true })}/mo</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {map.unownedUsd !== 0 && <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>{usd(map.unownedUsd, { sign: true })}/mo is on files no CODEOWNERS rule covers.</p>}
              </div>
              <div className="card callout">
                <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>In the PR check</h3>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  <code>npm run profile</code> exports the costly files with the cost profile. When a PR touches one, the Action lists its cost history and owners in the comment, even if no pattern in the diff fires.
                </p>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                Each change&apos;s measured impact goes to the files its attribution pointed at; when it named none, it&apos;s split over the change&apos;s runtime files by lines changed. Tests, docs and lockfiles never carry cost.
              </p>
            </aside>
          </div>
        </>
      )}
    </>
  );
}
