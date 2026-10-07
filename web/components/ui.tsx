import Link from "next/link";
import type { Warning } from "@commitcost/action";
import { BASIS_LABELS, INPUT_SOURCE_LABELS, formatInputValue, type CostEstimate } from "@commitcost/engine";
import { pct, usd } from "@/lib/format";

export function Meter({ value, label }: { value: number; label?: string }) {
  return (
    <div className="meter" title={label}>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className="meter-label">{pct(value)}</span>
    </div>
  );
}

export function DirectionBadge({ direction, deltaUsd, suffix = "/day" }: { direction: "increase" | "decrease"; deltaUsd: number; suffix?: string }) {
  const up = direction === "increase";
  return (
    <span className={`badge ${up ? "inc" : "dec"}`}>
      {up ? "▲" : "▼"} {usd(deltaUsd, { sign: true })}
      {suffix}
    </span>
  );
}

/** Renders a unified diff hunk; `highlight` marks lines containing the given text. */
export function Diff({ patch, highlightLine, maxLines = 40 }: { patch: string; highlightLine?: number; maxLines?: number }) {
  const out: { cls: string; text: string; hl: boolean }[] = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (m) {
      newLine = Number(m[1]);
      out.push({ cls: "hunk", text: raw, hl: false });
      continue;
    }
    const kind = raw[0];
    const cls = kind === "+" ? "add" : kind === "-" ? "del" : "";
    const hl = highlightLine != null && kind !== "-" && newLine === highlightLine;
    out.push({ cls, text: raw, hl });
    if (kind !== "-") newLine++;
  }
  const shown = out.slice(0, maxLines);
  return (
    <div className="diff mono">
      {shown.map((l, i) => (
        <div key={i} className={`${l.cls}${l.hl ? " hl" : ""}`}>
          {l.text || " "}
        </div>
      ))}
      {out.length > shown.length && <div className="hunk">… {out.length - shown.length} more lines</div>}
    </div>
  );
}

export function WarningCard({ w, n }: { w: Warning; n: number }) {
  return (
    <div className="warning">
      <div className="row">
        <strong>
          {n}. {w.title}
        </strong>
        <span className="amount up-bad">
          {w.calibrated
            ? `~${usd(w.calibrated.monthlyUsd, { sign: true })}/mo`
            : w.impact.monthlyUsd != null
              ? `${w.impact.estimate.range?.lowUsd === 0 ? "≤" : "~"}${usd(w.impact.monthlyUsd, { sign: true })}/mo`
              : "impact varies"}
        </span>
      </div>
      <div className="mono muted">
        {w.file}
        {w.line ? `:${w.line}` : ""}
      </div>
      <dl className="kv">
        <dt>Why</dt>
        <dd>{w.why}</dd>
        <dt>Estimated impact</dt>
        <dd>
          {w.impact.summary} <span className={`badge basis-${w.impact.estimate.basis}`}>{BASIS_LABELS[w.impact.estimate.basis]}</span>
          <Calculation e={w.impact.estimate} />
        </dd>
        {w.calibrated && (
          <>
            <dt>Adjusted by receipts</dt>
            <dd>
              {usd(w.calibrated.monthlyUsd, { sign: true })}/mo (×{w.calibrated.factor.toFixed(2)}). {w.calibrated.note}
            </dd>
          </>
        )}
        <dt>Suggested fix</dt>
        <dd>{w.suggestion}</dd>
        <dt>Confidence</dt>
        <dd>
          <Meter value={w.confidence} />
        </dd>
      </dl>
      <Diff patch={w.snippet} />
    </div>
  );
}

export function ShaLink({ sha, prNumber, title }: { sha: string; prNumber: number | null; title: string }) {
  return (
    <Link className="title-link" href={`/changes/${sha.slice(0, 12)}`}>
      {prNumber ? `#${prNumber} ` : ""}
      {title}
    </Link>
  );
}

/** The formula, every input with where it came from, and the assumptions behind an estimate. */
export function Calculation({ e, open = false }: { e: CostEstimate; open?: boolean }) {
  if (e.inputs.length === 0 && e.assumptions.length === 0) return null;
  return (
    <details className="calc" open={open}>
      <summary>How this was calculated</summary>
      <div className="calc-formula mono">{e.formula}</div>
      {e.calibration && (
        <p className="calc-note">
          {e.calibration.note} From the diff alone: {usd(e.calibration.diffOnlyMonthlyUsd, { sign: true })}/mo.
        </p>
      )}
      <table className="calc-inputs">
        <thead>
          <tr>
            <th>Input</th>
            <th className="num">Value</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {e.inputs.map((i, n) => (
            <tr key={n}>
              <td>{i.label}</td>
              <td className="num mono">{formatInputValue(i)}</td>
              <td>
                <span className={`src src-${i.source}`}>{INPUT_SOURCE_LABELS[i.source]}</span>
                {i.ref && <div className="muted calc-ref">{i.ref}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {e.assumptions.length > 0 && (
        <ul className="calc-assumptions">
          {e.assumptions.map((a, n) => (
            <li key={n}>{a}</li>
          ))}
        </ul>
      )}
      <p className="muted calc-ref">
        {e.region} · {e.priceSource}
      </p>
    </details>
  );
}
