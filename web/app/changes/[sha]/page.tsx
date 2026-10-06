import Link from "next/link";
import { notFound } from "next/navigation";
import { renderComment } from "@commitcost/action";
import { DirectionBadge, Diff, Meter, WarningCard } from "@/components/ui";
import { getChange } from "@/lib/data";
import { SERVICE_NAMES, fmtDate, usd } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ChangePage({ params }: { params: Promise<{ sha: string }> }) {
  const { sha } = await params;
  const data = await getChange(sha);
  if (!data) notFound();
  const { deploy: d, warnings, attributions } = data;
  const caused = attributions.filter((a) => a.rank === 1 && a.confidence >= 0.4);

  return (
    <>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        <Link href="/changes">Changes</Link> / {d.prNumber ? `#${d.prNumber}` : d.sha.slice(0, 7)}
      </p>
      <h1>
        {d.prNumber ? `#${d.prNumber} ` : ""}
        {d.title}
      </h1>
      <p className="sub">
        {d.author} merged <span className="mono">{d.sha.slice(0, 7)}</span> into {d.repo} on {fmtDate(d.mergedAt, true)}
        {d.url && (
          <>
            {" · "}
            <a href={d.url}>View on GitHub</a>
          </>
        )}
      </p>

      <div className="layout-main">
        <section className="stack">
          <div className="card">
            <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Pre-merge cost review</h3>
            <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
              What the CommitCost GitHub Action comments on this PR.
            </p>
            {warnings.length === 0 ? (
              <div className="callout">✅ No cost risks found in this diff.</div>
            ) : (
              warnings.map((w, i) => <WarningCard key={`${w.file}:${w.line}:${w.detector}`} w={w} n={i + 1} />)
            )}
            {warnings.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary>PR comment markdown</summary>
                <pre className="comment-preview">{renderComment(warnings, { repo: d.repo, headSha: d.sha })}</pre>
              </details>
            )}
          </div>
          <div className="card">
            <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Diff</h3>
            {d.files.map((f) => (
              <div key={f.path}>
                <div className="file-head mono">
                  <span>{f.path}</span>
                  <span>
                    <span className="down-good">+{f.additions}</span> <span className="up-bad">−{f.deletions}</span>
                  </span>
                </div>
                {f.patch ? <Diff patch={f.patch} maxLines={60} /> : <p className="muted">No patch available.</p>}
              </div>
            ))}
          </div>
        </section>
        <aside className="card">
          <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Cost changes linked to this PR</h3>
          {attributions.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Not a suspect for any cost anomaly.</p>
          ) : (
            <ul className="list" style={{ marginTop: 10 }}>
              {attributions.map((a) => (
                <li key={a.anomalyId}>
                  <div className="row">
                    <Link className="title-link" href={`/anomalies/${a.anomalyId}`}>
                      {SERVICE_NAMES[a.service]} on {fmtDate(a.onsetDate)}
                    </Link>
                    <span className="muted" style={{ fontSize: 12 }}>
                      suspect #{a.rank}
                    </span>
                  </div>
                  <div className="row" style={{ marginTop: 4 }}>
                    <DirectionBadge direction={a.direction} deltaUsd={a.monthlyImpactUsd} suffix="/mo" />
                    <div style={{ width: 140 }}>
                      <Meter value={a.confidence} />
                    </div>
                  </div>
                  <p className="explanation" style={{ fontSize: 13 }}>
                    {a.explanation}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {caused.length > 0 && (
            <div className="callout" style={{ marginTop: 12, fontSize: 13 }}>
              Net effect: <strong>{usd(caused.reduce((s, a) => s + a.monthlyImpactUsd, 0), { sign: true })}/mo</strong> across {caused.length} cost change{caused.length === 1 ? "" : "s"}.
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
