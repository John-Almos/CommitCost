import Link from "next/link";
import { notFound } from "next/navigation";
import { ServiceChart } from "@/components/ServiceChart";
import { DirectionBadge, Diff, Meter, ShaLink, WarningCard } from "@/components/ui";
import { getAnomaly } from "@/lib/data";
import { SERVICE_NAMES, fmtDate, pct, usd, usdFull } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AnomalyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getAnomaly(id);
  if (!data) notFound();
  const { anomaly: a, suspects, series, topWarnings } = data;
  const top = suspects[0];
  const confident = top && top.confidence >= 0.4;
  const name = SERVICE_NAMES[a.service] ?? a.service;

  return (
    <>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        <Link href="/">Overview</Link> / {name} anomaly
      </p>
      <h1>
        {name} {a.direction === "increase" ? "cost increase" : "cost decrease"} on {fmtDate(a.onsetDate, true)}
      </h1>
      <p className="sub">
        {usdFull(a.baselineUsd)}/day expected, {usdFull(a.observedUsd)}/day observed
        {a.tagValue ? `, concentrated in app=${a.tagValue}` : ""}. {a.persistent ? "Cost stayed at the new level." : `A ${a.durationDays}-day blip that returned to baseline.`}
      </p>

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="tile-label">Daily change</div>
          <div className="tile-value">
            <DirectionBadge direction={a.direction} deltaUsd={a.deltaUsd} />
          </div>
          <div className="tile-delta">{pct(Math.abs(a.deltaUsd) / Math.max(a.baselineUsd, 1))} vs baseline</div>
        </div>
        <div className="card">
          <div className="tile-label">{a.persistent ? "Monthly impact" : "One-off excess"}</div>
          <div className={`tile-value ${a.monthlyImpactUsd > 0 ? "up-bad" : "down-good"}`}>
            {usd(a.monthlyImpactUsd, { sign: true })}
            {a.persistent ? "/mo" : ""}
          </div>
          <div className="tile-delta">{a.persistent ? "daily delta × 30" : `over ${a.durationDays} day${a.durationDays === 1 ? "" : "s"}`}</div>
        </div>
        <div className="card">
          <div className="tile-label">Most likely cause</div>
          {confident ? (
            <>
              <div style={{ marginTop: 6 }}>
                <ShaLink sha={top.deploy.sha} prNumber={top.deploy.prNumber} title={top.deploy.title} />
              </div>
              <div style={{ marginTop: 8 }}>
                <Meter value={top.confidence} />
              </div>
            </>
          ) : (
            <div className="tile-delta" style={{ marginTop: 8 }}>
              No change explains this well. It may be traffic or something outside the repo.
            </div>
          )}
        </div>
      </div>

      <div className="card chart-card" style={{ marginBottom: 16 }}>
        <div className="chart-head">
          <h3>Daily {name} cost</h3>
          <span className="muted">4 weeks before to 3 weeks after onset</span>
        </div>
        <ServiceChart series={series} height={200} activeId={a.id} />
      </div>

      <div className="layout-main">
        <section className="stack">
          <h3 style={{ margin: 0 }}>Ranked suspects</h3>
          {suspects.length === 0 && <div className="card empty">No changes were merged in the 3 days before onset.</div>}
          {suspects.map((s) => {
            const ev = s.evidence[0];
            const file = ev && s.deploy.files.find((f) => f.path === ev.file);
            return (
              <article key={s.deploy.sha} className={`suspect${s.rank === 1 && confident ? " top" : ""}`}>
                <div className="row" style={{ alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
                    <span className="rank">{s.rank}</span>
                    <div style={{ minWidth: 0 }}>
                      <ShaLink sha={s.deploy.sha} prNumber={s.deploy.prNumber} title={s.deploy.title} />
                      <div className="muted" style={{ fontSize: 13 }}>
                        {s.deploy.author} · merged {fmtDate(s.deploy.mergedAt)} · <span className="mono">{s.deploy.sha.slice(0, 7)}</span>
                      </div>
                    </div>
                  </div>
                  <div style={{ width: 150, flex: "none" }}>
                    <Meter value={s.confidence} label="Confidence" />
                  </div>
                </div>
                <p className="explanation">{s.explanation}</p>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Timing {pct(s.scores.timing)} · Relevance {pct(s.scores.relevance)} · {s.explanationSource === "llm" ? "Explained by Claude" : "Heuristic explanation"}
                </div>
                {ev && (
                  <>
                    <div className="file-head mono">
                      <span>
                        {ev.file}
                        {ev.line ? `:${ev.line}` : ""}
                      </span>
                      <span className="muted">{ev.detail}</span>
                    </div>
                    {file?.patch ? <Diff patch={file.patch} highlightLine={ev.line} maxLines={s.rank === 1 ? 40 : 14} /> : ev.snippet && <Diff patch={ev.snippet} />}
                  </>
                )}
              </article>
            );
          })}
        </section>

        <aside className="stack">
          <div className="card">
            <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Would the PR check have caught it?</h3>
            {!confident ? (
              <p className="muted" style={{ margin: 0 }}>No confident suspect to check.</p>
            ) : topWarnings.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No pre-merge warning for {top.deploy.prNumber ? `#${top.deploy.prNumber}` : "this change"}. The cost came from a pattern the PR check doesn&apos;t flag on its own.
              </p>
            ) : (
              <>
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                  Yes. The CommitCost Action would have commented on {top.deploy.prNumber ? `#${top.deploy.prNumber}` : "this change"} before merge:
                </p>
                {topWarnings.map((w, i) => (
                  <WarningCard key={`${w.file}:${w.line}:${w.detector}`} w={w} n={i + 1} />
                ))}
                <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>
                  The pre-merge estimate uses list prices and default assumptions because it can&apos;t see your bill. The observed impact was {usd(a.monthlyImpactUsd, { sign: true })}/mo.
                </p>
              </>
            )}
          </div>
          {confident && (
            <div className="card">
              <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Files in {top.deploy.prNumber ? `#${top.deploy.prNumber}` : "the change"}</h3>
              <table>
                <tbody>
                  {top.deploy.files.map((f) => (
                    <tr key={f.path}>
                      <td className="mono" style={{ wordBreak: "break-all" }}>
                        {f.path}
                      </td>
                      <td className="num">
                        <span className="down-good">+{f.additions}</span> <span className="up-bad">−{f.deletions}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
