"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ServiceSeries } from "@/lib/data";
import { fmtDate, usd, usdFull } from "@/lib/format";

interface Props {
  series: ServiceSeries;
  height?: number;
  /** Anomaly to emphasize (on its own detail page). */
  activeId?: string;
}

const PAD = { top: 12, right: 12, bottom: 24, left: 48 };

/** Round a max up to 1, 2, 2.5 or 5 × 10^n so the top tick reads cleanly. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

export function ServiceChart({ series, height = 150, activeId }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { points, markers } = series;
  const geom = useMemo(() => {
    const max = niceMax(Math.max(...points.map((p) => p.usd)) * 1.05);
    const iw = width - PAD.left - PAD.right;
    const ih = height - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (points.length <= 1 ? 0 : (i / (points.length - 1)) * iw);
    const y = (v: number) => PAD.top + ih - (v / max) * ih;
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.usd).toFixed(1)}`).join("");
    const area = `${line}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
    const index = new Map(points.map((p, i) => [p.date, i]));
    // About five evenly spaced date labels.
    const step = Math.max(1, Math.ceil(points.length / 5));
    const ticks = points.map((p, i) => ({ i, date: p.date })).filter(({ i }) => i % step === 0);
    return { max, iw, ih, x, y, line, area, index, ticks };
  }, [points, width, height]);

  if (points.length === 0) return <div className="empty">No cost data.</div>;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.round(rel * (points.length - 1)));
  };

  const hp = hover != null ? points[hover] : undefined;
  const hoverMarker = hp && markers.find((m) => m.date === hp.date);
  const tipLeft = hover != null ? geom.x(hover) : 0;

  return (
    <div className="chart-wrap" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={`Daily ${series.service} cost`}>
        {[0, geom.max / 2, geom.max].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={geom.y(v)} y2={geom.y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
            <text x={PAD.left - 6} y={geom.y(v) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {usd(v)}
            </text>
          </g>
        ))}
        {geom.ticks.map((t) => (
          <text key={t.date} x={geom.x(t.i)} y={height - 4} textAnchor={t.i === 0 ? "start" : "middle"} fontSize={11} fill="var(--muted)">
            {fmtDate(t.date)}
          </text>
        ))}
        <path d={geom.area} fill="var(--series-wash)" />
        <path d={geom.line} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hp && (
          <>
            <line x1={tipLeft} x2={tipLeft} y1={PAD.top} y2={geom.y(0)} stroke="var(--axis)" strokeWidth={1} />
            <circle cx={tipLeft} cy={geom.y(hp.usd)} r={4} fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />
          </>
        )}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={geom.iw}
          height={geom.ih}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
        {markers.map((m) => {
          const i = geom.index.get(m.date);
          if (i == null) return null;
          const up = m.direction === "increase";
          const cx = geom.x(i);
          const cy = geom.y(points[i]!.usd);
          const active = m.id === activeId;
          return (
            <Link key={m.id} href={`/anomalies/${m.id}`} className="marker" aria-label={`${up ? "Increase" : "Decrease"} of ${usd(m.deltaUsd, { sign: true })}/day starting ${fmtDate(m.date)}`}>
              <circle cx={cx} cy={cy} r={14} fill="transparent" />
              {active && <circle cx={cx} cy={cy} r={11} fill="none" stroke={up ? "var(--critical)" : "var(--good)"} strokeWidth={1.5} strokeDasharray="2 2" />}
              <circle cx={cx} cy={cy} r={7} fill={up ? "var(--critical)" : "var(--good)"} stroke="var(--surface)" strokeWidth={2} />
              <text x={cx} y={cy + 3} textAnchor="middle" fontSize={8} fill="#fff" style={{ pointerEvents: "none" }}>
                {up ? "▲" : "▼"}
              </text>
            </Link>
          );
        })}
      </svg>
      {hp && (
        <div className="tooltip" style={{ left: Math.min(Math.max(tipLeft - 70, 0), width - 170), top: 0 }}>
          <div className="muted">{fmtDate(hp.date, true)}</div>
          <div>
            <span className="k" />
            <span className="v">{usdFull(hp.usd)}</span> <span className="muted">/ day</span>
          </div>
          {hoverMarker && (
            <div className={hoverMarker.direction === "increase" ? "up-bad" : "down-good"}>
              {hoverMarker.direction === "increase" ? "▲" : "▼"} anomaly {usd(hoverMarker.deltaUsd, { sign: true })}/day · click marker
            </div>
          )}
        </div>
      )}
      <details>
        <summary>Table view</summary>
        <div style={{ maxHeight: 220, overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Cost</th>
                <th>Anomaly</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => {
                const m = markers.find((mk) => mk.date === p.date);
                return (
                  <tr key={p.date}>
                    <td>{fmtDate(p.date, true)}</td>
                    <td className="num">{usdFull(p.usd)}</td>
                    <td>{m ? <Link href={`/anomalies/${m.id}`}>{m.direction === "increase" ? "▲" : "▼"} {usd(m.deltaUsd, { sign: true })}/day</Link> : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
