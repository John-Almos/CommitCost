import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFixPatch, invertHunks } from "./fixPatch.js";

const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
function merged(): string[] {
  const l = [...base];
  l[4] = "changed 5";
  l.splice(20, 0, "inserted A", "inserted B");
  l.splice(33, 1); // removes "line 32"
  return l;
}
const text = (l: string[]) => `${l.join("\n")}\n`;

let dir: string | undefined;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

/** A real repo with the change committed; returns the PR's patch for a.txt as GitHub shows it (hunks only). */
function repoWithChange(context: number): string {
  dir = mkdtempSync(join(tmpdir(), "commitcost-fix-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "a.txt"), text(base));
  git("add", "a.txt");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  writeFileSync(join(dir, "a.txt"), text(merged()));
  const diff = git("diff", `-U${context}`, "a.txt");
  return diff.slice(diff.indexOf("@@"));
}

function apply(patch: string, context: number): string {
  writeFileSync(join(dir!, "fix.patch"), patch.endsWith("\n") ? patch : `${patch}\n`);
  // git refuses zero-context hunks unless told they are intended.
  execFileSync("git", ["apply", ...(context === 0 ? ["--unidiff-zero"] : []), "fix.patch"], { cwd: dir });
  return readFileSync(join(dir!, "a.txt"), "utf8");
}

describe("invertHunks", () => {
  for (const context of [0, 3]) {
    it(`reverts every hunk to the original file (-U${context})`, () => {
      const patch = repoWithChange(context);
      const inv = invertHunks("a.txt", patch);
      expect(apply(inv.text, context)).toBe(text(base));
    });

    it(`reverts only the selected hunks and keeps the rest (-U${context})`, () => {
      const patch = repoWithChange(context);
      // Undo the insertion (new lines 21-22) and the deletion (old line 32); keep "changed 5".
      const inv = invertHunks("a.txt", patch, (h) => (h.newStart <= 21 && h.newEnd >= 21) || (h.oldStart <= 32 && h.oldEnd >= 32));
      const expected = [...base];
      expected[4] = "changed 5";
      expect(inv.hunks).toBe(2);
      expect(apply(inv.text, context)).toBe(text(expected));
    });
  }
});

describe("buildFixPatch", () => {
  const lambda = `@@ -44,8 +44,8 @@ functions:
   generateReports:
     handler: src/handlers/generateReports.handler
-    memorySize: 512
-    timeout: 30
+    memorySize: 3008
+    timeout: 300
     events:
       - sqs:
           arn: !GetAtt ReportQueue.Arn`;

  it("reverts the hunk with the cost finding and reports what it undoes", () => {
    const fix = buildFixPatch([{ path: "services/worker/serverless.yml", patch: lambda }, { path: "README.md", patch: "@@ -1 +1 @@\n-a\n+b" }], { services: ["Lambda"] });
    expect(fix?.files).toEqual([{ path: "services/worker/serverless.yml", hunks: 1 }]);
    expect(fix?.findings.map((f) => f.detector)).toContain("lambda-config");
    expect(fix?.patch).toContain("-    memorySize: 3008\n");
    expect(fix?.patch).toContain("+    memorySize: 512\n");
    expect(fix?.patch.startsWith("diff --git a/services/worker/serverless.yml b/services/worker/serverless.yml\n")).toBe(true);
  });

  it("returns null when the diff has nothing tied to the increase", () => {
    expect(buildFixPatch([{ path: "README.md", patch: "@@ -1 +1 @@\n-a\n+b" }], { services: ["RDS"] })).toBeNull();
  });

  it("uses evidence lines when no detector fires", () => {
    const fix = buildFixPatch([{ path: "src/x.ts", patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }], { evidence: [{ file: "src/x.ts", line: 2 }] });
    expect(fix?.patch).toContain("@@ -1,3 +1,2 @@\n a\n-b\n c");
  });
});
