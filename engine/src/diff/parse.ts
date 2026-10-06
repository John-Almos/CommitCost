/** Unified-diff parsing for GitHub `patch` fields (hunks only, no file headers). */

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** Line number in the old file (del/ctx). */
  oldLine?: number;
  /** Line number in the new file (add/ctx). */
  newLine?: number;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parsePatch(patch: string | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const m = raw.match(HUNK_RE);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      current = { header: m[3]!.trim(), lines: [] };
      hunks.push(current);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (!current) {
      // Some patches arrive without a hunk header; number from 1.
      current = { header: "", lines: [] };
      hunks.push(current);
      oldLine = newLine = 1;
    }
    if (raw.startsWith("+")) current.lines.push({ kind: "add", text: raw.slice(1), newLine: newLine++ });
    else if (raw.startsWith("-")) current.lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++ });
    else current.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldLine: oldLine++, newLine: newLine++ });
  }
  return hunks;
}

export function indentOf(text: string): number {
  const m = text.match(/^[ \t]*/)![0];
  return m.replace(/\t/g, "  ").length;
}

/** The new-file view of a hunk: context and added lines, in order. */
export function newSide(hunk: Hunk): DiffLine[] {
  return hunk.lines.filter((l) => l.kind !== "del");
}

/** The old-file view of a hunk: context and removed lines, in order. */
export function oldSide(hunk: Hunk): DiffLine[] {
  return hunk.lines.filter((l) => l.kind !== "add");
}
