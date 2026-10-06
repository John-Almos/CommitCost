import { describe, expect, it } from "vitest";
import { readSyncConfig } from "./config.js";

describe("readSyncConfig", () => {
  it("lists every missing setting without echoing secrets", () => {
    expect(() => readSyncConfig({})).toThrow(/GITHUB_TOKEN[\s\S]*GITHUB_REPO/);
  });

  it("reads defaults and options", () => {
    const config = readSyncConfig({ GITHUB_TOKEN: "ghp_x", GITHUB_REPO: "acme/app", COMMITCOST_TAG_KEY: "app", COMMITCOST_DAYS: "60" });
    expect(config).toEqual({
      days: 60,
      github: { token: "ghp_x", repo: "acme/app", branch: undefined },
      aws: { tagKey: "app", metric: "UnblendedCost", accountId: undefined },
    });
  });

  it("rejects bad values", () => {
    const base = { GITHUB_TOKEN: "t", GITHUB_REPO: "a/b" };
    expect(() => readSyncConfig({ ...base, COMMITCOST_COST_METRIC: "BlendedCost" })).toThrow(/COMMITCOST_COST_METRIC/);
    expect(() => readSyncConfig({ ...base, COMMITCOST_DAYS: "5" })).toThrow(/COMMITCOST_DAYS/);
  });
});
