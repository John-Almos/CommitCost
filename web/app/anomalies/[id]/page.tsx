import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyButton } from "@/components/CopyButton";
import { ServiceChart } from "@/components/ServiceChart";
import { Calculation, DirectionBadge, Diff, Meter, ShaLink, WarningCard } from "@/components/ui";
import { getAnomaly } from "@/lib/data";
import { getFix } from "@/lib/history";
import { fmtRate, type CostFix } from "@commitcost/engine";
import type { ModeledImpact } from "@/lib/data";
import { SERVICE_NAMES, fmtDate, pct, usd, usdFull } from "@/lib/format";

const qty = (n: number) => (n >= 1e6 ? `${(n / 1e6).toPrecision(3)}M` : n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toPrecision(3));
const rate = (n: number) => fmtRate(n);

/** The cost model's estimate (from the diff and the usage before merge) next to what the bill then showed. */
function ModeledVsMeasured({ modeled, measured, persistent }: { modeled: ModeledImpact; measured: number; persistent: boolean }) {
  const bound = modeled.items.some((i) => i.estimate.range?.lowUsd === 0);
  return (
    <table style={{ marginTop: 4, fontSize: 13 }}>
      <tbody>
        <tr>
          <td>Modeled from the diff</td>
          <td className="num">{modeled.monthlyUsd !== undefined ? `${bound ? "up to " : ""}${usd(modeled.monthlyUsd, { sign: true })}/mo` : "per-unit only"}</td>
        </tr>
        <tr>
          <td>Measured in the bill</td>
          <td className="num">
            {usd(measured, { sign: true })}
            {persistent ? "/mo" : " one-off"}
          </td>
        </tr>
        <tr>
          <td colSpan={2} className="muted" style={{ fontSize: 12 }}>
            The model prices the diff with list prices and the two weeks of usage before the merge. The bill measures what actually happened.
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** A partial revert of the lines behind the increase, with what it would save today. */
function FixCard({ fix }: { fix: CostFix }) {
  const pr = fix.prNumber ? `#${fix.prNumber}` : fix.commitSha.slice(0, 7);
  const file = `commitcost-fix-${fix.prNumber ?? fix.commitSha.slice(0, 7)}.patch`;
  return (
    <div className="card">
      <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Undo this cost</h3>
      <div className="fix-saving">{usdFull(fix.remainingUsd)}/mo</div>
      <p className="muted" style={{ margin: "2px 0 10px", fontSize: 13 }}>
        {fix.laterSavingsUsd < 0
          ? `${pr} added ${usdFull(fix.savingsUsd)}/mo; later changes to the same files already saved ${usdFull(-fix.laterSavingsUsd)}/mo, so reverting would save about this much now.`
          : `Measured in the bill. Reverting only the lines below should save about this much; the rest of ${pr} stays.`}
      </p>
      {fix.suggestions.length > 0 && (
        <p style={{ margin: "0 0 8px", fontSize: 13 }}>
          <strong>Better fix:</strong> {fix.suggestions[0]}
        </p>
      )}
      {fix.laterChanges.length > 0 && (
        <p className="callout" style={{ fontSize: 12.5, margin: "0 0 8px" }}>
          Changed again since: {fix.laterChanges.map((c) => (c.prNumber ? `#${c.prNumber}` : c.commitSha.slice(0, 7))).join(", ")}. The patch may need a manual merge.
        </p>
      )}
      <Diff patch={fix.fix.patch.split("\n").filter((l) => !/^(diff --git|--- a\/|\+\+\+ b\/)/.test(l)).join("\n")} maxLines={30} />
      <div className="copy-row">
        <CopyButton text={fix.fix.patch} />
        <span className="muted" style={{ fontSize: 12 }}>
          then <code className="cmd">git apply {file}</code>
        </span>
      </div>
      <p className="muted calc-ref" style={{ marginTop: 8 }}>
        Or from the CLI: <code>npm run fix -- {fix.prNumber ?? fix.commitSha.slice(0, 7)} {file}</code>
      </p>
    </div>
  );
}

export const dynamic = "force-dynamic";

export default async function AnomalyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getAnomaly(id);
  if (!data) notFound();
  const { anomaly: a, suspects, series, topWarnings, billChanges, modeled } = data;
  const top = suspects[0];
  const confident = top && top.confidence >= 0.4;
  const fix = confident && a.direction === "increase" && a.persistent ? await getFix(top.deploy.sha) : null;
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
          <div className="tile-delta">{a.persistent ? "measured: daily change in the bill × 30" : `measured over ${a.durationDays} day${a.durationDays === 1 ? "" : "s"}`}</div>
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

      {billChanges.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>What changed in the bill</h3>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            {name} usage by usage type{a.tagValue ? ` under app=${a.tagValue}` : ""}, daily average for the week before onset vs the week from onset.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Usage type</th>
                  <th className="num">Before</th>
                  <th className="num">After</th>
                  <th className="num">Cost/day</th>
                  <th className="num">Paid per unit</th>
                </tr>
              </thead>
              <tbody>
                {billChanges.slice(0, 6).map((c) => (
                  <tr key={c.usageType}>
                    <td>
                      {c.description}
                      <div className="muted mono calc-ref">{c.usageType}</div>
                    </td>
                    <td className="num">
                      {qty(c.beforeQty)} {c.unit}
                    </td>
                    <td className="num">
                      {qty(c.afterQty)} {c.unit}
                    </td>
                    <td className={`num ${c.afterUsd > c.beforeUsd ? "up-bad" : "down-good"}`}>{usdFull(c.afterUsd - c.beforeUsd, true)}</td>
                    <td className="num mono">{rate(c.afterQty > 0 ? c.afterUsd / c.afterQty : c.beforeUsd / Math.max(c.beforeQty, 1e-9))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
          {fix && <FixCard fix={fix} />}
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
              </>
            )}
          </div>
          {confident && modeled && modeled.items.length > 0 && (
            <div className="card">
              <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Modeled vs measured</h3>
              <ModeledVsMeasured modeled={modeled} measured={a.monthlyImpactUsd} persistent={a.persistent} />
              {modeled.items.map((i) => (
                <div key={i.title} style={{ marginTop: 10, fontSize: 13 }}>
                  <strong>{i.title}</strong>: {i.estimate.summary}
                  <Calculation e={i.estimate} />
                </div>
              ))}
              <p style={{ margin: "10px 0 0" }}>
                <Link href="/cost-model" style={{ fontSize: 13 }}>
                  How costs are calculated →
                </Link>
              </p>
            </div>
          )}
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
