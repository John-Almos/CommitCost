import { VERDICT_LABELS, fmtUsd, type CostReceipt } from "@commitcost/engine";
import type { GitHub } from "./github.js";

export const RECEIPT_MARKER = "<!-- commitcost:cost-receipt -->";

const ICON: Record<CostReceipt["verdict"], string> = {
  "on-target": "🎯",
  under: "📈",
  over: "📉",
  flagged: "🚩",
  "wrong-direction": "↕️",
  "no-effect": "➖",
  missed: "🕳️",
  pending: "⏳",
};

/** The follow-up comment on a merged PR: what the PR check predicted, and what the bill then measured. */
export function renderReceipt(r: CostReceipt, dashboardUrl?: string): string {
  const lines = r.lines.map((l) => `| ${l.title} | \`${l.file}${l.line ? `:${l.line}` : ""}\` | ${l.predictedUsd !== undefined ? `${fmtUsd(l.predictedUsd, { sign: true })}/mo` : l.summary || "no amount"} |`);
  const measured = r.measured.map((m) => `| ${m.service}${m.tagValue ? ` (app=${m.tagValue})` : ""} | ${m.onsetDate} | ${fmtUsd(m.monthlyUsd, { sign: true })}/mo | ${Math.round(m.confidence * 100)}% |`);
  return [
    RECEIPT_MARKER,
    `### ${ICON[r.verdict]} CommitCost receipt: ${VERDICT_LABELS[r.verdict].toLowerCase()}`,
    "",
    r.summary,
    "",
    ...(lines.length ? ["**Predicted before merge**", "", "| Finding | Where | Estimate |", "|---|---|---|", ...lines, ""] : []),
    ...(measured.length ? ["**Measured in the bill**", "", "| Service | From | Change | Attribution confidence |", "|---|---|---|---|", ...measured, ""] : []),
    r.verdict === "missed"
      ? "The PR check had no rule for what caused this. It's recorded so the gap shows up in the accuracy report."
      : r.ratio !== undefined
        ? "Future estimates from these checks are adjusted by what receipts like this one show."
        : "",
    "",
    `<sub>${r.daysObserved} billing days after merge.${dashboardUrl ? ` [Details](${dashboardUrl})` : ""} This comment is updated if the numbers change.</sub>`,
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export type ReceiptAction = "created" | "updated" | "unchanged" | "skipped";

/** Posts or updates the receipt comment on its PR. Pending receipts and direct pushes are skipped. */
export async function postReceipt(gh: GitHub, r: CostReceipt, dashboardUrl?: string): Promise<ReceiptAction> {
  if (r.verdict === "pending" || !r.prNumber) return "skipped";
  const body = renderReceipt(r, dashboardUrl);
  const existing = (await gh.listComments(r.repo, r.prNumber)).find((c) => c.body?.includes(RECEIPT_MARKER));
  if (existing) {
    if (existing.body === body) return "unchanged";
    await gh.updateComment(r.repo, existing.id, body);
    return "updated";
  }
  await gh.createComment(r.repo, r.prNumber, body);
  return "created";
}
