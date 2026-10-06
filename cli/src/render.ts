import type { Service } from "@commitcost/core";
import { SERVICES } from "@commitcost/core";
import type { DailyServiceTotal } from "@commitcost/db";
import type { MockDataset } from "@commitcost/providers";

const BARS = "▁▂▃▄▅▆▇█";
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

export function usd(n: number, digits = 0): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function sparkline(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v) => BARS[Math.min(BARS.length - 1, Math.floor(((v - min) / span) * BARS.length))]).join("");
}

/** Per-service sparklines with markers under the days an injected change hit. */
export function renderServiceCharts(totals: DailyServiceTotal[], dataset: MockDataset): string {
  const dates = [...new Set(totals.map((t) => t.date))].sort();
  const index = new Map(dates.map((d, i) => [d, i]));
  const out: string[] = [];
  const label = (s: string) => s.padEnd(13);

  out.push(`${label("")}${dim(dates[0]!)}${" ".repeat(Math.max(1, dates.length - 20))}${dim(dates.at(-1)!)}`);
  for (const service of SERVICES) {
    const series = new Array<number>(dates.length).fill(0);
    for (const t of totals) if (t.service === service) series[index.get(t.date)!] = t.amountUsd;

    const markers = new Array<string>(dates.length).fill(" ");
    for (const spike of dataset.spikes) {
      if (!spike.effects.some((e) => e.service === service)) continue;
      const i = index.get(spike.onsetDate);
      if (i !== undefined) markers[i] = spike.direction === "increase" ? red("▲") : green("▼");
    }
    for (const event of dataset.unexplained) {
      const i = index.get(event.date);
      if (event.service === service && i !== undefined) markers[i] = yellow("?");
    }

    const first = series.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
    const last = series.slice(-7).reduce((a, b) => a + b, 0) / 7;
    const change = ((last - first) / first) * 100;
    const changeText = `${usd(first)}/d → ${usd(last)}/d (${change >= 0 ? "+" : ""}${change.toFixed(0)}%)`;
    out.push(`${bold(label(service))}${cyan(sparkline(series))}  ${changeText}`);
    out.push(`${label("")}${markers.join("")}`);
  }
  out.push(`${label("")}${red("▲")} injected increase  ${green("▼")} injected decrease  ${yellow("?")} blip with no code cause`);
  return out.join("\n");
}

export function renderSpikeTable(dataset: MockDataset): string {
  const rows = dataset.spikes.map((s) => {
    const services = [...new Set(s.effects.map((e) => e.service))].join(" + ") as Service | string;
    const delta = `${s.dailyDeltaUsd >= 0 ? "+" : ""}${usd(s.dailyDeltaUsd)}/day`;
    const monthly = `${s.estimatedMonthlyImpactUsd >= 0 ? "+" : ""}${usd(s.estimatedMonthlyImpactUsd)}/mo`;
    const arrow = s.direction === "increase" ? red("▲") : green("▼");
    return [
      `${arrow} ${bold(s.onsetDate)}  ${bold(services.padEnd(19))} ${delta.padStart(12)}  ${monthly.padStart(12)}`,
      `   caused by #${s.prNumber} ${bold(`"${s.title}"`)} by @${s.author}`,
      `   ${dim(`merged ${s.mergedAt.slice(0, 16).replace("T", " ")} UTC, ${s.lagDays} day(s) before onset, commit ${s.commitSha.slice(0, 7)}`)}`,
      `   ${s.why}`,
    ].join("\n");
  });
  const blips = dataset.unexplained.map(
    (u) => `${yellow("?")} ${bold(u.date)}  ${bold(u.service.padEnd(19))} ${`+${usd(u.deltaUsd)} for 1 day`.padStart(26)}\n   ${u.why}`,
  );
  return [...rows, ...blips].join("\n\n");
}

/** Ranked suspects per anomaly. With ground truth (mock mode), marks hits and misses. */
export function renderReports(
  reports: import("@commitcost/engine").AnomalyReport[],
  /** Mock mode: the commit known to cause this anomaly, if any. */
  expectedCause?: (anomaly: import("@commitcost/core").CostAnomaly) => string | undefined,
  maxSuspects = 3,
): string {
  if (reports.length === 0) return dim("No anomalies found.");
  return reports
    .map(({ anomaly: a, suspects }) => {
      const arrow = a.direction === "increase" ? red("▲") : green("▼");
      const delta = `${a.deltaUsd >= 0 ? "+" : "-"}${usd(Math.abs(a.deltaUsd))}/day`;
      const impact = a.persistent ? `${a.estimatedMonthlyImpactUsd >= 0 ? "+" : "-"}${usd(Math.abs(a.estimatedMonthlyImpactUsd))}/mo` : `one-off ${usd(a.estimatedMonthlyImpactUsd)}`;
      const scope = a.tagValue ? dim(` app=${a.tagValue}`) : "";
      const lines = [`${arrow} ${bold(a.onsetDate)}  ${bold(a.service)}${scope}  ${delta}  ${impact}  ${dim(`(${a.durationDays}d, score ${a.score})`)}`];

      if (suspects.length === 0) lines.push(`   ${dim("No deploys in the lookback window.")}`);
      for (const s of suspects.slice(0, maxSuspects)) {
        const hit = expectedCause?.(a) === s.commitSha ? green(" ✓ injected cause") : "";
        const conf = `${Math.round(s.confidence * 100)}%`.padStart(4);
        const label = `#${s.rank} ${conf}  ${s.prNumber ? `PR #${s.prNumber}` : s.commitSha.slice(0, 7)} ${s.title}`;
        lines.push(`   ${s.rank === 1 ? bold(label) : dim(label)}${hit}`);
        if (s.rank === 1) {
          lines.push(`      ${s.explanation}${s.explanationSource === "llm" ? dim(" (LLM)") : ""}`);
          for (const e of s.evidence.slice(0, 1)) lines.push(dim(`      ${e.file}${e.line ? `:${e.line}` : ""}`));
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
