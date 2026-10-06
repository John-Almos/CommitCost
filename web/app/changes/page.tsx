import Link from "next/link";
import { ShaLink } from "@/components/ui";
import { listChanges } from "@/lib/data";
import { SERVICE_NAMES, fmtDate, usd } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ChangesPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams;
  const all = await listChanges();
  const changes = filter === "cost" ? all.filter((c) => c.attributed.length > 0 || c.warnings > 0) : all;
  const flagged = all.filter((c) => c.attributed.length > 0 || c.warnings > 0).length;

  return (
    <>
      <h1>Changes</h1>
      <p className="sub">Every merged change, with the cost anomalies it was blamed for and the warnings the PR check raises on its diff.</p>
      <div className="filters">
        <div className="seg">
          <Link href="/changes" aria-current={filter !== "cost" ? "true" : undefined}>
            All {all.length}
          </Link>
          <Link href="/changes?filter=cost" aria-current={filter === "cost" ? "true" : undefined}>
            Cost-relevant {flagged}
          </Link>
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th style={{ paddingLeft: 20 }}>Change</th>
              <th>Merged</th>
              <th>Caused</th>
              <th className="num">Monthly impact</th>
              <th className="num" style={{ paddingRight: 20 }}>
                PR check
              </th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const impact = c.attributed.reduce((s, a) => s + a.monthlyImpactUsd, 0);
              return (
                <tr key={c.sha}>
                  <td style={{ paddingLeft: 20 }}>
                    <ShaLink sha={c.sha} prNumber={c.prNumber} title={c.title} />
                    <div className="muted" style={{ fontSize: 12 }}>
                      {c.author} · <span className="mono">{c.sha.slice(0, 7)}</span> · {c.files.length} file{c.files.length === 1 ? "" : "s"}
                    </div>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDate(c.mergedAt)}</td>
                  <td>
                    {c.attributed.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      c.attributed.map((a) => (
                        <div key={a.anomalyId}>
                          <Link href={`/anomalies/${a.anomalyId}`}>
                            {a.monthlyImpactUsd > 0 ? "▲" : "▼"} {SERVICE_NAMES[a.service]} {fmtDate(a.onsetDate)}
                          </Link>
                        </div>
                      ))
                    )}
                  </td>
                  <td className="num">
                    {c.attributed.length ? <span className={`amount ${impact > 0 ? "up-bad" : "down-good"}`}>{usd(impact, { sign: true })}/mo</span> : <span className="muted">—</span>}
                  </td>
                  <td className="num" style={{ paddingRight: 20 }}>
                    {c.warnings ? (
                      <span className="badge inc">
                        ⚠ {c.warnings} warning{c.warnings === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <span className="muted">clean</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
