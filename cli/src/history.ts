import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GitHub, postReceipt } from "@commitcost/action";
import { loadCodeowners, loadDeploys, loadTopAttributions, loadUsageRecords, type PrismaClient } from "@commitcost/db";
import {
  VERDICT_LABELS,
  buildReceipts,
  codeMapFrom,
  fixFor,
  learnCalibration,
  receiptStats,
  type CalibrationTable,
  type CodeMap,
  type CostFix,
  type CostReceipt,
  type HistoryInput,
} from "@commitcost/engine";
import { localPriceBook } from "./profile.js";
import { bold, cyan, dim, green, red, usd, yellow } from "./render.js";

/** Everything the history features need, loaded from the database. */
export async function loadHistory(db: PrismaClient, repo?: string): Promise<HistoryInput & { codeowners?: string }> {
  const [deploys, attributions, usage] = await Promise.all([loadDeploys(db, repo), loadTopAttributions(db), loadUsageRecords(db)]);
  if (attributions.length === 0 && deploys.length === 0) throw new Error("Nothing analyzed yet. Run `npm run seed` (mock) or `npm run sync`, then `npm run analyze`.");
  const latest = usage.reduce<string | undefined>((m, u) => (!m || u.date > m ? u.date : m), undefined);
  const dataEnd = latest ?? attributions.map((a) => a.onsetDate).sort().at(-1) ?? new Date().toISOString().slice(0, 10);
  return { deploys, attributions, usage, prices: localPriceBook(), dataEnd, codeowners: await loadCodeowners(db, repo) };
}

const VERDICT_COLOR: Record<CostReceipt["verdict"], (s: string) => string> = {
  "on-target": green,
  under: yellow,
  over: yellow,
  flagged: cyan,
  "wrong-direction": red,
  "no-effect": dim,
  missed: red,
  pending: dim,
};

const pr = (r: { prNumber: number | null; commitSha: string }) => (r.prNumber ? `PR #${r.prNumber}` : r.commitSha.slice(0, 7));
const money = (n: number) => `${n >= 0 ? "+" : ""}${usd(n)}`;

export function renderReceipts(receipts: CostReceipt[], calibration: CalibrationTable, limit = 12): string {
  const s = receiptStats(receipts);
  const out = [
    bold(`Cost receipts`) + dim("  (PR check prediction vs the bill after merge)"),
    `${s.judged} judged: ${s.caught} flagged before merge (${s.onTarget} within 0.67–1.5× of the bill), ${s.missed} missed, ${s.noEffect} with no change seen.` +
      (s.catchRate !== undefined ? ` Catch rate ${Math.round(s.catchRate * 100)}%.` : "") +
      (s.medianError !== undefined ? ` Median error ${Math.round(s.medianError * 100)}%.` : ""),
    "",
  ];
  for (const r of receipts.slice(0, limit)) {
    out.push(`  ${VERDICT_COLOR[r.verdict](VERDICT_LABELS[r.verdict].padEnd(19))} ${pr(r).padEnd(9)} ${r.title.slice(0, 54).padEnd(54)} ${dim(r.summary)}`);
  }
  if (receipts.length > limit) out.push(dim(`  … ${receipts.length - limit} more`));
  const cal = Object.values(calibration);
  if (cal.length) {
    out.push("", bold("Learned corrections") + dim("  (applied to the next PR check through the cost profile)"));
    for (const c of cal) out.push(`  ${c!.detector.padEnd(22)} ×${c!.factor.toFixed(2)}  ${dim(`median measured/predicted ${c!.medianRatio.toFixed(2)} over ${c!.samples} receipt${c!.samples === 1 ? "" : "s"}`)}`);
  }
  return out.join("\n");
}

export function renderCodeMap(map: CodeMap, limit = 8): string {
  const out = [bold("Code cost map") + dim("  (attributed monthly cost still on the bill, by the code that caused it)")];
  out.push(dim("  Directories"));
  const top = map.dirs.filter((d) => d.path.split("/").length <= 3).sort((a, b) => b.monthlyUsd - a.monthlyUsd).slice(0, limit);
  for (const d of top) out.push(`    ${d.path.padEnd(32)} ${money(d.monthlyUsd).padStart(9)}/mo ${dim(`(${money(d.increaseUsd)} added, ${money(d.decreaseUsd)} saved)`)} ${dim(d.owners.join(" "))}`);
  out.push(dim("  Files"));
  for (const f of map.files.slice(0, limit)) {
    const split = f.decreaseUsd < 0 ? ` (${money(f.increaseUsd)} added, ${money(f.decreaseUsd)} saved)` : "";
    out.push(`    ${f.path.padEnd(44)} ${money(f.monthlyUsd).padStart(9)}/mo ${dim(`${f.changes.map((c) => (c.prNumber ? `#${c.prNumber}` : c.commitSha.slice(0, 7))).join(", ")}${split}`)}`);
  }
  if (map.owners.length) {
    out.push(dim("  Owners"));
    for (const o of map.owners.slice(0, limit)) out.push(`    ${o.owner.padEnd(24)} ${money(o.monthlyUsd).padStart(9)}/mo ${dim(`${o.files.length} file${o.files.length === 1 ? "" : "s"}`)}`);
  }
  return out.join("\n");
}

export function renderFix(f: CostFix): string {
  return [
    bold(`Fix patch for ${pr(f)} "${f.title}"`) +
      (f.laterSavingsUsd < 0
        ? `  added ${usd(f.savingsUsd)}/mo (${f.services.join(", ")}, measured); later changes already saved ${usd(-f.laterSavingsUsd)}/mo, so reverting saves about ${green(`${usd(f.remainingUsd)}/mo`)}`
        : `  saves about ${green(`${usd(f.savingsUsd)}/mo`)} (${f.services.join(", ")}, measured)`),
    dim(`Reverts ${f.fix.files.map((x) => `${x.hunks} hunk${x.hunks === 1 ? "" : "s"} in ${x.path}`).join(", ")}; the rest of the PR stays.`),
    ...f.suggestions.map((s) => dim(`Better fix: ${s}`)),
    ...(f.laterChanges.length ? [yellow(`Later changes touched the same files (${f.laterChanges.map(pr).join(", ")}); the patch may need a manual merge.`)] : []),
  ].join("\n");
}

/** `commitcost receipts [--post]` */
export async function receiptsCommand(db: PrismaClient, args: string[], env = process.env): Promise<void> {
  const history = await loadHistory(db, env.GITHUB_REPO || undefined);
  const receipts = buildReceipts(history);
  console.log(renderReceipts(receipts, learnCalibration(receipts), args.includes("--all") ? Infinity : 12));
  if (!args.includes("--post")) {
    console.log(dim("\nRun with --post to add each receipt as a comment on its merged PR (needs GITHUB_TOKEN with pull request write access)."));
    return;
  }
  if (!env.GITHUB_TOKEN) throw new Error("--post needs GITHUB_TOKEN with pull request write access.");
  const gh = new GitHub(env.GITHUB_TOKEN, undefined, env.GITHUB_API_URL || undefined);
  const counts: Record<string, number> = {};
  for (const r of receipts) {
    const action = await postReceipt(gh, r, env.COMMITCOST_DASHBOARD_URL ? `${env.COMMITCOST_DASHBOARD_URL.replace(/\/$/, "")}/receipts#${r.commitSha.slice(0, 12)}` : undefined);
    counts[action] = (counts[action] ?? 0) + 1;
  }
  console.log(`\nReceipt comments: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
}

/** `commitcost map` */
export async function mapCommand(db: PrismaClient, env = process.env): Promise<void> {
  const h = await loadHistory(db, env.GITHUB_REPO || undefined);
  console.log(renderCodeMap(codeMapFrom(h.deploys, h.attributions, h.codeowners), 12));
}

/** `commitcost fix <pr-number|sha> [out.patch]` */
export async function fixCommand(db: PrismaClient, args: string[], env = process.env): Promise<boolean> {
  const ref = args[0];
  if (!ref) throw new Error("Usage: commitcost fix <pr-number|sha> [out.patch]");
  const h = await loadHistory(db, env.GITHUB_REPO || undefined);
  const deploy = h.deploys.find((d) => (/^\d+$/.test(ref.replace(/^#/, "")) ? d.prNumber === Number(ref.replace(/^#/, "")) : d.commitSha.startsWith(ref)));
  if (!deploy) throw new Error(`No merged change matches "${ref}".`);
  const fix = fixFor(deploy, h.attributions, h.deploys);
  if (!fix) {
    console.log(`No fix patch for ${pr(deploy)}: no persistent cost increase is confidently attributed to it, or nothing in its diff can be tied to one.`);
    return false;
  }
  console.error(renderFix(fix));
  if (args[1]) {
    mkdirSync(dirname(args[1]), { recursive: true });
    writeFileSync(args[1], fix.fix.patch);
    console.error(dim(`Wrote ${args[1]}. Apply it on your default branch with: git apply ${args[1]}`));
  } else {
    process.stdout.write(fix.fix.patch);
  }
  return true;
}
