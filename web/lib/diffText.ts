import type { FileDiff } from "@commitcost/engine";

/** Joins per-file patches into `git diff` text. */
export function toGitDiff(files: { path: string; patch?: string | null }[]): string {
  return files
    .filter((f) => f.patch)
    .map((f) => `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n${f.patch}`)
    .join("\n");
}

/**
 * Splits `git diff` output into per-file patches shaped like GitHub's PR files
 * API. A bare hunk with no file header is treated as one unnamed file.
 */
export function parseGitDiff(text: string): FileDiff[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const parts = normalized.split(/^diff --git /m);
  const files: FileDiff[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const header = /^a\/(\S+) b\/(\S+)/.exec(part);
    const plusPath = /^\+\+\+ (?:b\/)?(\S+)/m.exec(part)?.[1];
    const path = plusPath && plusPath !== "/dev/null" ? plusPath : header?.[2] ?? "untitled";
    const hunk = part.indexOf("\n@@");
    const patch = part.startsWith("@@") ? part : hunk >= 0 ? part.slice(hunk + 1) : "";
    if (patch) files.push({ path, patch: patch.replace(/\n+$/, "") });
  }
  return files;
}
