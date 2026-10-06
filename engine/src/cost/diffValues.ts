/** Small readers for values stated in a diff snippet or patch. */

const kv = (keys: RegExp, value = "[\\w.-]+") => new RegExp(`\\b(?:${keys.source})["']?\\s*[:=]\\s*["']?(${value})`, "i");

/** New-side `key = N` / `key: N` (removed lines skipped). */
export function numberIn(text: string, keys: RegExp): number | null {
  const re = kv(keys, "\\d+(?:\\.\\d+)?");
  for (const line of text.split("\n")) {
    if (line.startsWith("-")) continue;
    const m = line.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

export function stringIn(text: string, keys: RegExp): string | null {
  const re = kv(keys);
  for (const line of text.split("\n")) {
    if (line.startsWith("-")) continue;
    const m = line.match(re);
    if (m) return m[1]!;
  }
  return null;
}

/** "- key = old" and "+ key = new" values. */
export function changedValues(text: string, keys: RegExp): { from: string; to: string } | null {
  const lines = text.split("\n");
  const re = kv(keys);
  const from = lines.find((l) => l.startsWith("-") && re.test(l))?.match(re)?.[1];
  const to = lines.find((l) => l.startsWith("+") && re.test(l))?.match(re)?.[1];
  return from && to ? { from, to } : null;
}

export const COUNT_KEYS = /desired_capacity|desiredCapacity|desiredCount|desired_count|min_size|minSize|replicas|instance_count|instanceCount|count/;

/** Instance count keys, most telling first: what runs, then the floor. */
const COUNT_PRIORITY = [/desired_capacity|desiredCapacity|desiredCount|desired_count/, /instance_count|instanceCount|replicas|\bcount/, /min_size|minSize/];

/** How many instances the new side of the diff runs, and which key said so. */
export function instanceCountIn(...texts: string[]): { count: number; key: string } | null {
  for (const keys of COUNT_PRIORITY) {
    for (const text of texts) {
      const n = numberIn(text, keys);
      if (n !== null) return { count: n, key: keys.source.split("|")[0]!.replace("\\b", "") };
    }
  }
  return null;
}
export const SIZE_KEYS = /instance_type|instanceType|InstanceType|instance_class|instanceClass|DBInstanceClass|node_type|nodeType/;

/** Region named in infrastructure code: `region = "us-west-2"`, `provider = aws.us_west_2`. */
export function regionInDiff(text: string): string | undefined {
  const m = text.match(/(?:\bregion["']?\s*[:=]\s*["']?|\baws\.)((?:us|eu|ap|ca|sa|me|af|il|mx)[-_](?:north|south|east|west|central|northeast|southeast|southwest|northwest)[-_]\d)\b/i);
  return m ? m[1]!.replace(/_/g, "-").toLowerCase() : undefined;
}

/** Every region named in the text, in order of appearance. */
export function regionsInDiff(text: string): string[] {
  const re = /(?:\bregion["']?\s*[:=]\s*["']?|\baws\.)((?:us|eu|ap|ca|sa|me|af|il|mx)[-_](?:north|south|east|west|central|northeast|southeast|southwest|northwest)[-_]\d)\b/gi;
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!.replace(/_/g, "-").toLowerCase()))];
}
