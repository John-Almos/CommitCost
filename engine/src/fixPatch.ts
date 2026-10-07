import type { Service } from "@commitcost/core";
import { analyzeFile } from "./diff/detectors.js";
import type { DiffFinding } from "./diff/types.js";

/**
 * Fix patches: a partial revert of only the hunks that caused a cost
 * increase, as a unified diff that `git apply` takes on top of the merged
 * code. Everything else the PR did stays.
 */

interface RawHunk {
  oldStart: number;
  newStart: number;
  context: string;
  /** Body lines, with their " ", "+", "-" or "\" prefix. */
  body: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

function parseRawHunks(patch: string): RawHunk[] {
  const hunks: RawHunk[] = [];
  const lines = patch.replace(/\n+$/, "").split("\n");
  for (const raw of lines) {
    const m = HUNK_RE.exec(raw);
    if (m) hunks.push({ oldStart: Number(m[1]), newStart: Number(m[2]), context: m[3] ?? "", body: [] });
    else if (hunks.length) hunks[hunks.length - 1]!.body.push(raw === "" ? " " : raw);
  }
  return hunks;
}

/** Old and new line counts, recomputed from the body (patch headers aren't always right). */
function counts(h: RawHunk): { old: number; new: number } {
  let o = 0;
  let n = 0;
  for (const l of h.body) {
    if (l.startsWith("+")) n++;
    else if (l.startsWith("-")) o++;
    else if (!l.startsWith("\\")) {
      o++;
      n++;
    }
  }
  return { old: o, new: n };
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

/**
 * Inverts the selected hunks of a file's patch so they apply to the new
 * (merged) file and restore the old lines. Hunks that aren't selected stay
 * applied, so later hunks' target line numbers shift only by the selected ones.
 */
export function invertHunks(path: string, patch: string, select: (hunk: { oldStart: number; oldEnd: number; newStart: number; newEnd: number }) => boolean = () => true): { text: string; hunks: number } {
  const out: string[] = [];
  let shift = 0;
  let selected = 0;
  for (const h of parseRawHunks(patch)) {
    const c = counts(h);
    if (!select({ oldStart: h.oldStart, oldEnd: h.oldStart + Math.max(c.old, 1) - 1, newStart: h.newStart, newEnd: h.newStart + Math.max(c.new, 1) - 1 })) continue;
    selected++;
    // Applying to the merged file: its "old" side is the PR's new side.
    // An empty side's start names the line before it, so pure adds and pure deletes shift by one.
    const target = h.newStart + shift + (c.new === 0 ? 1 : 0) - (c.old === 0 ? 1 : 0);
    out.push(`@@ -${range(h.newStart, c.new)} +${range(target, c.old)} @@${h.context ? ` ${h.context}` : ""}`);
    // Swap sides, keeping removals before additions within each run of changes, as diff tools print them.
    let dels: string[] = [];
    let adds: string[] = [];
    const flush = () => {
      out.push(...dels, ...adds);
      dels = [];
      adds = [];
    };
    for (const l of h.body) {
      if (l.startsWith("+")) dels.push(`-${l.slice(1)}`);
      else if (l.startsWith("-")) adds.push(`+${l.slice(1)}`);
      else {
        flush();
        out.push(l);
      }
    }
    flush();
    shift += c.old - c.new;
  }
  if (!selected) return { text: "", hunks: 0 };
  return { text: [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...out].join("\n"), hunks: selected };
}

export interface FixPatch {
  /** Unified diff for `git apply`. Ends with a newline. */
  patch: string;
  files: { path: string; hunks: number }[];
  /** The cost findings the patch undoes. */
  findings: DiffFinding[];
}

export interface FixOptions {
  /** Only undo findings that move these services (the ones the bill showed rising). */
  services?: Service[];
  /** Files the attribution pointed at; used when no detector fires on a file. */
  evidence?: { file: string; line?: number }[];
}

/**
 * Builds the partial revert for a change's cost increases: every hunk that
 * contains an increase finding on the given services (or an evidence line).
 * Null when nothing in the diff can be tied to the increase.
 */
export function buildFixPatch(files: { path: string; patch?: string | null }[], options: FixOptions = {}): FixPatch | null {
  const parts: string[] = [];
  const outFiles: FixPatch["files"] = [];
  const findings: DiffFinding[] = [];
  const services = options.services && new Set(options.services);

  for (const f of files) {
    if (!f.patch) continue;
    const hits = analyzeFile({ path: f.path, patch: f.patch }).filter(
      (x) => x.direction === "increase" && (!services || x.services.length === 0 || x.services.some((s) => services.has(s))),
    );
    const evidence = (options.evidence ?? []).filter((e) => e.file === f.path);
    if (hits.length === 0 && evidence.length === 0) continue;

    const targets = [
      ...hits.map((h) => ({ line: h.line, side: h.side })),
      ...evidence.map((e) => ({ line: e.line, side: "new" as const })),
    ];
    // A finding with no line (whole-file config) selects every hunk.
    const anyLine = targets.some((t) => t.line === undefined);
    const inv = invertHunks(f.path, f.patch, (h) =>
      anyLine || targets.some((t) => (t.side === "old" ? t.line! >= h.oldStart && t.line! <= h.oldEnd : t.line! >= h.newStart && t.line! <= h.newEnd)),
    );
    if (!inv.hunks) continue;
    parts.push(inv.text);
    outFiles.push({ path: f.path, hunks: inv.hunks });
    findings.push(...hits);
  }
  if (!parts.length) return null;
  return { patch: `${parts.join("\n")}\n`, files: outFiles, findings };
}
