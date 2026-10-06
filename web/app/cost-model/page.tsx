import Link from "next/link";
import { firstTier } from "@commitcost/core";
import { ASSUMPTION_DOCS, DEFAULT_PROFILE_DAYS, effectiveRatio, fmtRate, type CostAssumptions } from "@commitcost/engine";
import { getCostModel } from "@/lib/cost";
import { listCalibration } from "@/lib/data";
import { SERVICE_NAMES, fmtDate, usd, usdFull } from "@/lib/format";

export const dynamic = "force-dynamic";

const qty = (n: number) => (n >= 1e9 ? `${(n / 1e9).toPrecision(3)}B` : n >= 1e6 ? `${(n / 1e6).toPrecision(3)}M` : Math.round(n).toLocaleString("en-US"));
const UNIT: Record<string, string> = { Hrs: "hour", "GB-Mo": "GB-month", "Lambda-GB-Second": "GB-second", Requests: "request", ReadRequestUnits: "read unit", WriteRequestUnits: "write unit", GB: "GB" };

export default async function CostModelPage() {
  const { prices, region, profile, unitPrices, paths, assumptions } = await getCostModel();
  const calibration = await listCalibration();

  return (
    <>
      <h1>How costs are calculated</h1>
      <p className="sub">CommitCost computes cost two separate ways, and shows its working for both.</p>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="tile-label">Measured · Overview and anomalies</div>
          <p style={{ margin: "6px 0 0" }}>
            Read from your bill. Daily cost per service and tag comes from Cost Explorer. A cost change&apos;s size is the observed cost minus a weekday-aware 14-day median baseline, and its monthly impact is that daily change × 30.
          </p>
        </div>
        <div className="card">
          <div className="tile-label">Modeled · PR check and suspects</div>
          <p style={{ margin: "6px 0 0" }}>
            Calculated before anything is billed: <strong>quantity × unit price × your effective rate</strong>. Quantities come from the diff (instance counts, memory, capacity) or from your measured usage. Unit prices come from the AWS price list for the resource&apos;s region. Anything neither states is a named assumption you can override.
          </p>
        </div>
      </div>

      {calibration.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Modeled vs measured on past changes</h3>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            Each attributed change, priced from its diff with the two weeks of usage before it merged, next to what the bill measured afterwards.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Service</th>
                  <th className="num">Modeled</th>
                  <th className="num">Measured</th>
                  <th className="num">Ratio</th>
                </tr>
              </thead>
              <tbody>
                {calibration.map((c) => (
                  <tr key={c.anomalyId}>
                    <td>
                      <Link className="title-link" href={`/anomalies/${c.anomalyId}`}>
                        {c.prNumber ? `#${c.prNumber} ` : ""}
                        {c.title}
                      </Link>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {c.basis} · {fmtDate(c.onsetDate)}
                      </div>
                    </td>
                    <td>{c.services.map((s) => SERVICE_NAMES[s] ?? s).join(" + ")}</td>
                    <td className="num">{c.modeledUsd !== undefined ? `${c.upperBound ? "≤ " : ""}${usd(c.modeledUsd, { sign: true })}/mo` : "per unit"}</td>
                    <td className="num">{usd(c.measuredUsd, { sign: true })}/mo</td>
                    <td className="num">{c.modeledUsd !== undefined && c.measuredUsd !== 0 ? `${(c.modeledUsd / c.measuredUsd).toFixed(2)}×` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid-2" style={{ marginBottom: 16, alignItems: "start" }}>
        <div className="card">
          <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Unit prices</h3>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
            {prices.name}. {region} shown; {prices.regions().length} regions loaded ({prices.regions().join(", ")}). Estimates use the region named in the diff when there is one.
          </p>
          <table>
            <tbody>
              {unitPrices.map((u) => (
                <tr key={u.key}>
                  <td>
                    {u.label}
                    <div className="muted mono calc-ref">{u.key}</div>
                  </td>
                  <td className="num mono">
                    {fmtRate(firstTier(u.price!))}/{UNIT[u.price!.unit] ?? u.price!.unit}
                    {u.price!.tiers.length > 1 && <div className="muted calc-ref">{u.price!.tiers.length} volume tiers</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>
            The bundled snapshot is built from AWS&apos;s public price files (<code>npm run prices:snapshot</code>). Set <code>COMMITCOST_PRICING=live</code> to fetch current prices from the Price List API on sync.
          </p>
        </div>

        <div className="card">
          <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Network paths</h3>
          {paths.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No data transfer usage stored yet.</p>
          ) : (
            <>
              <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
                GB a month on each path from your usage, and what you pay per GB. Transfer estimates use these paths and prices.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Path</th>
                    <th className="num">GB/month</th>
                    <th className="num">Cost/month</th>
                    <th className="num">Paid per GB</th>
                  </tr>
                </thead>
                <tbody>
                  {paths.map((p) => (
                    <tr key={p.description}>
                      <td>{p.description}</td>
                      <td className="num">{qty(p.gbPerMonth)}</td>
                      <td className="num">{usdFull(p.usdPerMonth)}</td>
                      <td className="num mono">{fmtRate(p.paidPerGb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Your usage</h3>
        {!profile ? (
          <p className="muted" style={{ margin: 0 }}>
            No usage stored yet. Run <code>npm run demo</code> for mock data or <code>npm run sync</code> for your AWS account. Until then, estimates use values from the diff and the defaults below.
          </p>
        ) : (
          <>
            <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
              The last {DEFAULT_PROFILE_DAYS} days ({fmtDate(profile.window.start)} to {fmtDate(profile.window.end, true)}) by usage type and tag, scaled to a 730-hour month. &quot;Paid per unit&quot; is cost ÷ quantity, so Savings Plans, RIs and credits show up as a gap to list. Export it for the GitHub Action with <code>npm run profile</code>.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Usage</th>
                    <th>Tag</th>
                    <th className="num">Per month</th>
                    <th className="num">Cost/month</th>
                    <th className="num">Paid per unit</th>
                    <th className="num">vs list</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.lines.slice(0, 20).map((l) => {
                    const r = effectiveRatio([l]);
                    return (
                      <tr key={`${l.service}|${l.rawUsageType}|${l.tagValue}`}>
                        <td>
                          {l.description}
                          <div className="muted mono calc-ref">
                            {SERVICE_NAMES[l.service] ?? l.service} · {l.rawUsageType}
                          </div>
                        </td>
                        <td>{l.tagValue ? `app=${l.tagValue}` : <span className="muted">untagged</span>}</td>
                        <td className="num">
                          {qty(l.monthlyQuantity)} <span className="muted">{l.unit}</span>
                        </td>
                        <td className="num">{usdFull(l.monthlyCostUsd)}</td>
                        <td className="num mono">{l.effectiveRate !== undefined ? fmtRate(l.effectiveRate) : "–"}</td>
                        <td className={`num ${r < 1 ? "down-good" : ""}`}>{l.listRate ? (r === 1 ? "list" : `${r < 1 ? "−" : "+"}${Math.round(Math.abs(1 - r) * 100)}%`) : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Assumptions</h3>
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
          Used only when neither the diff nor your usage gives the value, and always listed under the estimate that used it. Override them with the Action&apos;s <code>assumptions</code> input, e.g. <code>{'{"cacheHitRate":0.9,"requestsPerMonth":30000000}'}</code>.
        </p>
        <table>
          <thead>
            <tr>
              <th>Assumption</th>
              <th className="num">Default</th>
              <th>Used for</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(ASSUMPTION_DOCS) as (keyof CostAssumptions)[]).map((k) => (
              <tr key={k}>
                <td>
                  {ASSUMPTION_DOCS[k].label}
                  <div className="muted mono calc-ref">{k}</div>
                </td>
                <td className="num">{assumptions[k] !== undefined ? `${assumptions[k]}${ASSUMPTION_DOCS[k].unit && assumptions[k] !== 1 ? ` ${ASSUMPTION_DOCS[k].unit}` : ""}` : <span className="muted">not set</span>}</td>
                <td className="ink2">{ASSUMPTION_DOCS[k].usedFor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
