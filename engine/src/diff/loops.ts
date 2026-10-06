import { indentOf, type DiffLine } from "./parse.js";

const LOOP_RE =
  /^\s*(for|while)\b|\bfor\s*\(|\bwhile\s*\(|\bfor\s+await\b|\.(forEach|map|flatMap|filter|reduce|each|times)\s*\(\s*(async\s*)?(\(|\w+\s*=>|function|\{|\|)|^\s*for\s+.+\s+in\s+.+:\s*$|\bdo\s*\{/;

export function isLoopHeader(text: string): boolean {
  if (/^\s*(\/\/|#|\*)/.test(text)) return false;
  return LOOP_RE.test(text);
}

export interface LoopBody {
  header: DiffLine;
  body: DiffLine[];
}

/**
 * Finds loop bodies in one side of a hunk by indentation: the lines after a
 * loop header that are indented deeper than it. That works for formatted
 * JS/TS, Python, Go and Ruby without a parser. A body that runs past the end
 * of the hunk is cut there.
 */
export function findLoops(lines: DiffLine[]): LoopBody[] {
  const loops: LoopBody[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    if (!isLoopHeader(header.text)) continue;
    const h = indentOf(header.text);
    const body: DiffLine[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.text.trim() === "") continue;
      if (indentOf(l.text) <= h) break;
      body.push(l);
    }
    if (body.length) loops.push({ header, body });
  }
  return loops;
}
