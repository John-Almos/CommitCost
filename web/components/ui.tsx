import Link from "next/link";
import type { Warning } from "@commitcost/action";
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
        <span className="amount up-bad">{w.impact.monthlyUsd != null ? `~${usd(w.impact.monthlyUsd, { sign: true })}/mo` : "impact varies"}</span>
      </div>
      <div className="mono muted">
        {w.file}
        {w.line ? `:${w.line}` : ""}
      </div>
      <dl className="kv">
        <dt>Why</dt>
        <dd>{w.why}</dd>
        <dt>Rough impact</dt>
        <dd>
          {w.impact.summary}
          {w.impact.assumptions && <span className="muted"> · Assumes: {w.impact.assumptions}</span>}
        </dd>
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
