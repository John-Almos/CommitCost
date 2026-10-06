import Link from "next/link";
import { ServiceChart } from "@/components/ServiceChart";
import { DirectionBadge, Meter } from "@/components/ui";
import { getOverview } from "@/lib/data";
import { SERVICE_NAMES, fmtDate, usd, usdFull } from "@/lib/format";

export const dynamic = "force-dynamic";

const RANGES = [30, 60, 90] as const;

export default async function Overview({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const { range: rangeParam } = await searchParams;
  const range = RANGES.find((r) => String(r) === rangeParam) ?? 90;
  const data = await getOverview(range);
  if (!data) {
    return (
      <div className="card empty">
        No cost data yet. Run <code>npm run demo</code> for mock data, or <code>npm run sync</code> with real credentials.
      </div>
    );
  }
  const change = data.prev30 > 0 ? (data.last30 - data.prev30) / data.prev30 : 0;
  const increases = data.anomalies.filter((a) => a.direction === "increase").length;

  return (
    <>
      <h1>Cloud cost by service</h1>
      <p className="sub">
        {fmtDate(data.start, true)} – {fmtDate(data.end, true)}. Markers are cost anomalies; click one to see which change caused it.
      </p>

      <div className="filters">
        <span className="ink2">Range</span>
        <div className="seg">
          {RANGES.map((r) => (
            <Link key={r} href={`/?range=${r}`} aria-current={r === range ? "true" : undefined}>
              {r} days
            </Link>
          ))}
        </div>
      </div>

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="tile-label">Spend, last 30 days</div>
          <div className="tile-value">{usdFull(data.last30)}</div>
          <div className="tile-delta">
            <span className={change > 0 ? "up-bad" : "down-good"}>
              {change > 0 ? "▲" : "▼"} {Math.abs(change * 100).toFixed(1)}%
            </span>{" "}
            vs previous 30 days
          </div>
        </div>
        <div className="card">
          <div className="tile-label">Anomalies in range</div>
          <div className="tile-value">{data.anomalies.length}</div>
          <div className="tile-delta">
            {increases} increase{increases === 1 ? "" : "s"}, {data.anomalies.length - increases} decrease{data.anomalies.length - increases === 1 ? "" : "s"}
          </div>
        </div>
        <div className="card">
          <div className="tile-label">Net monthly impact of lasting changes</div>
          <div className={`tile-value ${data.netMonthly > 0 ? "up-bad" : "down-good"}`}>{usd(data.netMonthly, { sign: true })}/mo</div>
          <div className="tile-delta">daily delta × 30, step changes only</div>
        </div>
      </div>

      <div className="layout-main">
        <div className="grid-2">
          {data.series.map((s) => (
            <div key={s.service} className="card chart-card">
              <div className="chart-head">
                <h3>{SERVICE_NAMES[s.service] ?? s.service}</h3>
                <span className="muted">{usdFull(s.total)} in range</span>
              </div>
              <ServiceChart series={s} />
            </div>
          ))}
        </div>

        <aside className="card">
          <h3 style={{ margin: "0 0 2px", fontSize: 15 }}>Top cost-impacting changes</h3>
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
            Last {range} days, by monthly impact
          </p>
          {data.topChanges.length === 0 ? (
            <div className="empty">No attributed changes in this range.</div>
          ) : (
            <ol className="list">
              {data.topChanges.map((a) => (
                <li key={a.id}>
                  <div className="row">
                    <Link className="title-link" href={`/anomalies/${a.id}`}>
                      {a.topSuspect!.prNumber ? `#${a.topSuspect!.prNumber} ` : ""}
                      {a.topSuspect!.title}
                    </Link>
                    <span className={`amount ${a.monthlyImpactUsd > 0 ? "up-bad" : "down-good"}`}>{usd(a.monthlyImpactUsd, { sign: true })}/mo</span>
                  </div>
                  <div className="row" style={{ marginTop: 4 }}>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {SERVICE_NAMES[a.service]} · {fmtDate(a.onsetDate)}
                      {a.tagValue ? ` · app=${a.tagValue}` : ""}
                    </span>
                    <DirectionBadge direction={a.direction} deltaUsd={a.deltaUsd} />
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Meter value={a.topSuspect!.confidence} label="Attribution confidence" />
                  </div>
                </li>
              ))}
            </ol>
          )}
          {data.anomalies.some((a) => !a.topSuspect || a.topSuspect.confidence < 0.4) && (
            <div className="callout" style={{ marginTop: 14, fontSize: 13 }}>
              <strong>Unexplained:</strong>{" "}
              {data.anomalies
                .filter((a) => !a.topSuspect || a.topSuspect.confidence < 0.4)
                .map((a, i) => (
                  <span key={a.id}>
                    {i ? ", " : ""}
                    <Link href={`/anomalies/${a.id}`}>
                      {SERVICE_NAMES[a.service]} {usd(a.deltaUsd, { sign: true })}/day on {fmtDate(a.onsetDate)}
                    </Link>
                  </span>
                ))}
              . No recent change looks responsible.
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
