import type { DeployFile, Service } from "@commitcost/core";

/**
 * Code cost map: the bill changes CommitCost attributed to merged changes,
 * rolled up onto the code that caused them (files, directories) and the
 * people who own that code (CODEOWNERS). It answers "which parts of the
 * codebase have added the most to the bill", which no bill-side tool can.
 */

/** A merged change with the bill changes attributed to it. */
export interface AttributedChange {
  commitSha: string;
  prNumber: number | null;
  title: string;
  author: string;
  mergedAt: string;
  files: Pick<DeployFile, "path" | "additions" | "deletions">[];
  /** Files the attribution pointed at as the cause. */
  evidenceFiles: string[];
  services: Service[];
  /** Measured monthly impact of the attributed bill changes. Negative is a saving. */
  monthlyUsd: number;
  anomalyIds: string[];
}

export interface CodeMapChange {
  commitSha: string;
  prNumber: number | null;
  title: string;
  mergedAt: string;
  /** This file's or directory's share of the change's monthly impact. */
  monthlyUsd: number;
  anomalyIds: string[];
}

export interface CodeCost {
  path: string;
  /** Net monthly impact still on the bill (increases minus savings). */
  monthlyUsd: number;
  increaseUsd: number;
  decreaseUsd: number;
  services: Service[];
  owners: string[];
  changes: CodeMapChange[];
}

export interface CodeMap {
  files: CodeCost[];
  /** Every directory with attributed cost, each with its children's total. */
  dirs: CodeCost[];
  owners: { owner: string; monthlyUsd: number; increaseUsd: number; decreaseUsd: number; files: string[] }[];
  /** Attributed monthly cost that landed on files no CODEOWNERS rule covers. */
  unownedUsd: number;
}

/** Test, generated and vendored files don't run in production, so they don't carry cost. */
const NOT_RUNTIME = /(^|\/)(node_modules|vendor|dist|build|coverage)\/|\.(lock|snap|md)$|package-lock\.json$|(^|\/)(__tests__|tests?|spec|fixtures?)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$/;

/**
 * Splits each change's impact over the files that caused it: the evidence
 * files when the attribution named any, otherwise its runtime files weighted
 * by lines changed.
 */
export function allocateToFiles(change: AttributedChange): { path: string; share: number }[] {
  const evidence = [...new Set(change.evidenceFiles)].filter((p) => change.files.some((f) => f.path === p));
  if (evidence.length) return evidence.map((path) => ({ path, share: 1 / evidence.length }));
  const runtime = change.files.filter((f) => !NOT_RUNTIME.test(f.path));
  const pool = runtime.length ? runtime : change.files;
  const total = pool.reduce((s, f) => s + Math.max(1, f.additions + f.deletions), 0);
  return pool.map((f) => ({ path: f.path, share: Math.max(1, f.additions + f.deletions) / total }));
}

export function buildCodeMap(changes: AttributedChange[], codeowners?: string): CodeMap {
  const rules = codeowners ? parseCodeowners(codeowners) : [];
  const files = new Map<string, CodeCost>();
  const dirs = new Map<string, CodeCost>();

  const add = (map: Map<string, CodeCost>, path: string, c: AttributedChange, usd: number) => {
    const row = map.get(path) ?? { path, monthlyUsd: 0, increaseUsd: 0, decreaseUsd: 0, services: [], owners: [], changes: [] };
    row.monthlyUsd += usd;
    if (usd >= 0) row.increaseUsd += usd;
    else row.decreaseUsd += usd;
    for (const s of c.services) if (!row.services.includes(s)) row.services.push(s);
    const existing = row.changes.find((x) => x.commitSha === c.commitSha);
    if (existing) existing.monthlyUsd += usd;
    else row.changes.push({ commitSha: c.commitSha, prNumber: c.prNumber, title: c.title, mergedAt: c.mergedAt, monthlyUsd: usd, anomalyIds: c.anomalyIds });
    map.set(path, row);
  };

  for (const c of changes) {
    for (const { path, share } of allocateToFiles(c)) {
      const usd = c.monthlyUsd * share;
      add(files, path, c, usd);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) add(dirs, `${parts.slice(0, i).join("/")}/`, c, usd);
    }
  }

  const ownerRows = new Map<string, CodeMap["owners"][number]>();
  let unownedUsd = 0;
  for (const f of files.values()) {
    f.owners = ownersFor(f.path, rules);
    if (f.owners.length === 0) unownedUsd += f.monthlyUsd;
    for (const o of f.owners) {
      // Shared ownership: each owner is accountable for the whole file.
      const row = ownerRows.get(o) ?? { owner: o, monthlyUsd: 0, increaseUsd: 0, decreaseUsd: 0, files: [] };
      row.monthlyUsd += f.monthlyUsd;
      row.increaseUsd += f.increaseUsd;
      row.decreaseUsd += f.decreaseUsd;
      row.files.push(f.path);
      ownerRows.set(o, row);
    }
  }
  for (const d of dirs.values()) d.owners = ownersFor(d.path, rules);

  const byImpact = (a: { increaseUsd: number; monthlyUsd: number }, b: { increaseUsd: number; monthlyUsd: number }) => b.monthlyUsd - a.monthlyUsd || b.increaseUsd - a.increaseUsd;
  for (const r of [...files.values(), ...dirs.values()]) r.changes.sort((a, b) => Math.abs(b.monthlyUsd) - Math.abs(a.monthlyUsd));
  return {
    files: [...files.values()].sort(byImpact),
    dirs: [...dirs.values()].sort((a, b) => a.path.localeCompare(b.path)),
    owners: [...ownerRows.values()].sort(byImpact),
    unownedUsd,
  };
}

/**
 * Cost history for the PR check: per file, the attributed increases still on
 * the bill. Only files whose increases reach `minUsd` are kept, so the
 * profile stays small.
 */
export interface FileCostHistory {
  path: string;
  increaseUsd: number;
  owners: string[];
  changes: { prNumber: number | null; title: string; monthlyUsd: number }[];
}

export function costHistory(map: CodeMap, minUsd = 100, limit = 200): FileCostHistory[] {
  return map.files
    .filter((f) => f.increaseUsd >= minUsd)
    .slice(0, limit)
    .map((f) => ({
      path: f.path,
      increaseUsd: Math.round(f.increaseUsd),
      owners: f.owners,
      changes: f.changes.filter((c) => c.monthlyUsd > 0).map((c) => ({ prNumber: c.prNumber, title: c.title, monthlyUsd: Math.round(c.monthlyUsd) })),
    }));
}

// ---- CODEOWNERS ----

export interface CodeownersRule {
  pattern: string;
  owners: string[];
  regex: RegExp;
}

/** Parses a CODEOWNERS file. Later rules take precedence, as on GitHub. */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || pattern.startsWith("[")) continue; // GitLab-style sections aren't GitHub syntax
    rules.push({ pattern, owners, regex: globToRegex(pattern) });
  }
  return rules;
}

/** Owners of a path (a file, or a directory ending in "/"): the last matching rule wins. */
export function ownersFor(path: string, rules: CodeownersRule[]): string[] {
  const dir = path.endsWith("/");
  const p = dir ? path.slice(0, -1) : path;
  for (let i = rules.length - 1; i >= 0; i--) {
    const { regex } = rules[i]!;
    // A directory is owned by a rule that covers what's inside it ("/infra/", "infra/**").
    if (regex.test(p) || (dir && regex.test(`${p}/x`))) return rules[i]!.owners;
  }
  return [];
}

/** gitignore-style pattern → regex over repo-relative paths. A match on a directory covers everything under it. */
export function globToRegex(pattern: string): RegExp {
  let p = pattern;
  // A slash anywhere but the end anchors the pattern to the repo root.
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  p = p.replace(/^\//, "");
  if (p.endsWith("/")) p += "**";
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${out}(?:/.*)?$`);
}
