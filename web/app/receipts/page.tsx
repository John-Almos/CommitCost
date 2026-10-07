import Link from "next/link";
import { renderReceipt } from "@commitcost/action";
import { VERDICT_LABELS, type CostReceipt } from "@commitcost/engine";
import { ShaLink } from "@/components/ui";
import { getReceipts } from "@/lib/history";
import { SERVICE_NAMES, fmtDate, pct, usd } from "@/lib/format";

export const dynamic = "force-dynamic";

const DETECTOR_NAMES: Record<string, string> = {
  "query-in-loop": "Query inside a loop",
  "removed-cache": "Cache removed",
  "removed-batching": "Batching removed",
  "compute-size": "Instance size",
  "capacity-increase": "Capacity increase",
  "lambda-config": "Lambda memory and timeout",
  "schedule-frequency": "Schedule frequency",
  "cross-region-transfer": "Cross-region transfer",
  "s3-lifecycle-removed": "S3 lifecycle removed",
  "hot-path-logging": "Logging in a hot path",
};

/** Predicted (top) and measured (bottom) on one signed scale centered on zero. */
function PredVsMeasured({ r, max }: { r: CostReceipt; max: number }) {
  const bar = (v: number | undefined, cls: string) => {
    if (v === undefined || v === 0) return null;
    const w = (Math.min(Math.abs(v), max) / max) * 50;
    return <div className={`pvm-bar ${cls}`} style={{ left: v > 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />;
  };
  return (
    <div className="pvm" aria-label={`Predicted ${r.predictedMonthlyUsd ?? "no amount"}, measured ${r.measuredMonthlyUsd}`}>
      <div className="pvm-axis" style={{ left: "50%" }} />
      {bar(r.predictedMonthlyUsd, "pred")}
      {bar(r.measuredMonthlyUsd, "meas")}
    </div>
  );
}

export default async function ReceiptsPage() {
  const { receipts, calibration, stats, dataEnd } = await getReceipts();
  const max = Math.max(1, ...receipts.flatMap((r) => [Math.abs(r.predictedMonthlyUsd ?? 0), Math.abs(r.measuredMonthlyUsd)]));
  const sample = receipts.find((r) => r.verdict !== "pending" && r.prNumber);
  const corrections = Object.values(calibration).sort((a, b) => Math.abs(Math.log(b!.factor)) - Math.abs(Math.log(a!.factor)));

  return (
    <>
      <h1>Cost receipts</h1>
      <p className="sub">
        Every merged change the PR check priced, or that the bill later moved on, with the estimate it gave before merge next to what the bill measured after. Each check learns a correction from these, and the next PR check uses it.
      </p>

      {receipts.length === 0 ? (
        <div className="card empty">No receipts yet. They appear once a change the PR check flagged has merged and a week of billing has landed.</div>
      ) : (
        <>
          <div className="grid-3" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="tile-label">Caught before merge</div>
              <div className="tile-value">{stats.catchRate !== undefined ? pct(stats.catchRate) : "—"}</div>
              <div className="tile-delta">
                of {stats.caught + stats.missed} attributed bill changes were flagged by the PR check{stats.missed ? `; ${stats.missed} missed` : ""}
              </div>
            </div>
            <div className="card">
              <div className="tile-label">Estimates on target</div>
              <div className="tile-value">
                {stats.onTarget} of {receipts.filter((r) => r.ratio !== undefined).length}
              </div>
              <div className="tile-delta">within 0.67× to 1.5× of the bill</div>
            </div>
            <div className="card">
              <div className="tile-label">Median estimate error</div>
              <div className="tile-value">{stats.medianError !== undefined ? pct(stats.medianError) : "—"}</div>
              <div className="tile-delta">|measured ÷ predicted − 1|, billing data through {fmtDate(dataEnd, true)}</div>
            </div>
          </div>

          <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 16 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 20 }}>Change</th>
                  <th>Verdict</th>
                  <th className="num">Predicted</th>
                  <th className="num">Measured</th>
                  <th style={{ paddingRight: 20 }}>
                    <div className="legend">
                      <span>
                        <span className="swatch" style={{ background: "var(--track)" }} />
                        predicted
                      </span>
                      <span>
                        <span className="swatch" style={{ background: "var(--series)" }} />
                        measured
                      </span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.commitSha} id={r.commitSha.slice(0, 12)}>
                    <td style={{ paddingLeft: 20, minWidth: 260 }}>
                      <ShaLink sha={r.commitSha} prNumber={r.prNumber} title={r.title} />
                      <div className="muted" style={{ fontSize: 12 }}>
                        merged {fmtDate(r.mergedAt)} · {r.lines.map((l) => DETECTOR_NAMES[l.detector] ?? l.detector).join(", ") || "no prediction"}
                        {r.measured.length > 0 && (
                          <>
                            {" · "}
                            {r.measured.map((m, i) => (
                              <span key={m.anomalyId ?? i}>
                                {i > 0 && ", "}
                                <Link href={`/anomalies/${m.anomalyId}`}>{SERVICE_NAMES[m.service] ?? m.service}</Link>
                              </span>
                            ))}
                          </>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`verdict ${r.verdict}`}>{VERDICT_LABELS[r.verdict]}</span>
                      {r.ratio !== undefined && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{r.ratio.toFixed(2)}× the estimate</div>}
                    </td>
                    <td className="num">{r.predictedMonthlyUsd !== undefined ? `${usd(r.predictedMonthlyUsd, { sign: true })}/mo` : <span className="muted">{r.lines.length ? "no amount" : "—"}</span>}</td>
                    <td className="num">{r.measured.length ? `${usd(r.measuredMonthlyUsd, { sign: true })}/mo` : <span className="muted">none seen</span>}</td>
                    <td style={{ paddingRight: 20 }}>
                      <PredVsMeasured r={r} max={max} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="layout-main">
            <div className="card">
              <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Learned corrections</h3>
              <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                Per check: the median of measured ÷ predicted, pulled toward 1× when there are few receipts so one PR can&apos;t swing it. <code>npm run profile</code> writes these into the cost profile, and the GitHub Action
                adjusts its estimates with them.
              </p>
              {corrections.length === 0 ? (
                <p className="muted">No priced receipts yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Check</th>
                      <th className="num">Median ratio</th>
                      <th className="num">Receipts</th>
                      <th className="num">Applied factor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {corrections.map((c) => (
                      <tr key={c!.detector}>
                        <td>{DETECTOR_NAMES[c!.detector] ?? c!.detector}</td>
                        <td className="num mono">{c!.medianRatio.toFixed(2)}×</td>
                        <td className="num">{c!.samples}</td>
                        <td className="num mono">
                          <strong>×{c!.factor.toFixed(2)}</strong>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {Math.abs(c!.factor - 1) < 0.05 ? "no change" : c!.factor > 1 ? "estimates raised" : "estimates lowered"}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {sample && (
              <div className="card">
                <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Receipt comment</h3>
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                  <code>npm run receipts -- --post</code> adds this to the merged PR, so its author and reviewers see how the estimate held up.
                </p>
                <pre className="comment-preview">{renderReceipt(sample)}</pre>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
