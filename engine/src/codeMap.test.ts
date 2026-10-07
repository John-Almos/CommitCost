import { describe, expect, it } from "vitest";
import { buildCodeMap, costHistory, globToRegex, ownersFor, parseCodeowners, type AttributedChange } from "./codeMap.js";

const OWNERS = `
# Default owner
*                     @acme/platform
/services/api/        @acme/api-team
/services/worker/     @acme/worker-team
*.tf                  @acme/infra   # terraform anywhere
docs/**               @acme/docs
`;

describe("CODEOWNERS", () => {
  const rules = parseCodeowners(OWNERS);

  it("uses the last matching rule", () => {
    expect(ownersFor("services/api/src/routes/orders.ts", rules)).toEqual(["@acme/api-team"]);
    expect(ownersFor("infra/terraform/s3.tf", rules)).toEqual(["@acme/infra"]);
    expect(ownersFor("web/src/pages/x.tsx", rules)).toEqual(["@acme/platform"]);
    expect(ownersFor("docs/a/b.md", rules)).toEqual(["@acme/docs"]);
  });

  it("owns directories by the rule covering their contents", () => {
    expect(ownersFor("services/api/", rules)).toEqual(["@acme/api-team"]);
    expect(ownersFor("services/", rules)).toEqual(["@acme/platform"]);
  });

  it("anchors patterns with a slash and floats bare names", () => {
    expect(globToRegex("/build/").test("build/x.js")).toBe(true);
    expect(globToRegex("/build/").test("src/build/x.js")).toBe(false);
    expect(globToRegex("build/").test("src/build/x.js")).toBe(true); // a trailing slash alone doesn't anchor
    expect(globToRegex("logs").test("a/logs/x")).toBe(true);
    expect(globToRegex("src/**/handlers").test("src/a/b/handlers/x.ts")).toBe(true);
  });
});

const change = (over: Partial<AttributedChange>): AttributedChange => ({
  commitSha: "a".repeat(40),
  prNumber: 1,
  title: "t",
  author: "x",
  mergedAt: "2026-08-01T00:00:00Z",
  files: [],
  evidenceFiles: [],
  services: ["RDS"],
  monthlyUsd: 0,
  anomalyIds: [],
  ...over,
});

describe("buildCodeMap", () => {
  const changes = [
    change({
      commitSha: "1".repeat(40),
      prNumber: 128,
      monthlyUsd: 2850,
      files: [
        { path: "services/api/src/routes/orders.ts", additions: 8, deletions: 1 },
        { path: "web/src/pages/orders/history.tsx", additions: 7, deletions: 0 },
      ],
      evidenceFiles: ["services/api/src/routes/orders.ts"],
    }),
    change({
      commitSha: "2".repeat(40),
      prNumber: 140,
      services: ["Lambda"],
      monthlyUsd: -900,
      files: [
        { path: "services/worker/serverless.yml", additions: 1, deletions: 1 },
        { path: "services/worker/serverless.test.ts", additions: 40, deletions: 0 },
      ],
    }),
  ];
  const map = buildCodeMap(changes, OWNERS);

  it("puts the cost on the evidence file, or splits it over runtime files", () => {
    expect(map.files.map((f) => [f.path, Math.round(f.monthlyUsd)])).toEqual([
      ["services/api/src/routes/orders.ts", 2850],
      ["services/worker/serverless.yml", -900],
    ]);
  });

  it("rolls costs up to every parent directory", () => {
    const services = map.dirs.find((d) => d.path === "services/")!;
    expect(services.monthlyUsd).toBe(1950);
    expect(services.increaseUsd).toBe(2850);
    expect(services.decreaseUsd).toBe(-900);
    expect(map.dirs.find((d) => d.path === "services/api/src/routes/")?.owners).toEqual(["@acme/api-team"]);
  });

  it("totals cost by owner", () => {
    expect(map.owners.map((o) => [o.owner, o.monthlyUsd])).toEqual([
      ["@acme/api-team", 2850],
      ["@acme/worker-team", -900],
    ]);
    expect(map.unownedUsd).toBe(0);
  });

  it("exports only meaningful increases as PR-check history", () => {
    expect(costHistory(map, 100)).toEqual([
      { path: "services/api/src/routes/orders.ts", increaseUsd: 2850, owners: ["@acme/api-team"], changes: [{ prNumber: 128, title: "t", monthlyUsd: 2850 }] },
    ]);
  });
});
