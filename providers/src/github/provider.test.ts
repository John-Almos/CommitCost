import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubApiError, parseNextLink, type FetchLike } from "./client.js";
import { GitHubProvider } from "./provider.js";

type Route = { status?: number; body: unknown; headers?: Record<string, string> };

/** Fake fetch keyed by path+query. Records requests and the headers sent. */
function fakeFetch(routes: Record<string, Route | Route[]>) {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    calls.push({ path, headers: init?.headers ?? {} });
    let route = routes[path];
    if (Array.isArray(route)) route = route.shift();
    if (!route) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "Not Found" };
    const headers = route.headers ?? {};
    const status = route.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    };
  };
  return { fetch, calls };
}

const pr = (number: number, merged_at: string | null, updated_at: string, sha = `sha${number}`) => ({
  number,
  title: `PR ${number}`,
  body: null,
  html_url: `https://github.com/acme/app/pull/${number}`,
  merged_at,
  updated_at,
  merge_commit_sha: sha,
  user: { login: `dev${number}` },
});

const PULLS = "/repos/acme/app/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100";

describe("GitHubProvider", () => {
  it("returns merged PRs in range with their files, plus direct pushes", async () => {
    const { fetch, calls } = fakeFetch({
      "/repos/acme/app": { body: { default_branch: "main" } },
      [PULLS]: {
        body: [
          pr(12, null, "2026-09-20T00:00:00Z"), // closed without merging
          pr(11, "2026-09-10T15:00:00Z", "2026-09-11T00:00:00Z"),
          pr(10, "2026-08-20T15:00:00Z", "2026-08-21T00:00:00Z"), // merged and last updated before range
        ],
        headers: { link: '<https://api.github.com/page2>; rel="next"' },
      },
      "/page2": { body: [pr(9, "2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z")] },
      "/repos/acme/app/pulls/11/files?per_page=100": {
        body: [{ filename: "src/a.ts", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }],
      },
      "/repos/acme/app/commits?sha=main&since=2026-09-01T00:00:00Z&until=2026-09-30T23:59:59Z&per_page=100": {
        body: [
          { sha: "sha11", html_url: "", commit: { message: "PR 11", author: null, committer: null }, author: null },
          { sha: "rebased", html_url: "", commit: { message: "part of a PR", author: null, committer: { date: "2026-09-12T00:00:00Z" } }, author: null },
          {
            sha: "hotfix",
            html_url: "https://github.com/acme/app/commit/hotfix",
            commit: { message: "Hotfix: bump timeout\n\nUrgent.", author: { name: "Ops", date: "2026-09-15T08:00:00Z" }, committer: { date: "2026-09-15T08:05:00Z" } },
            author: { login: "ops-bot" },
          },
        ],
      },
      "/repos/acme/app/commits/rebased/pulls": { body: [{ number: 11 }] },
      "/repos/acme/app/commits/hotfix/pulls": { body: [] },
      "/repos/acme/app/commits/hotfix": {
        body: { sha: "hotfix", files: [{ filename: "serverless.yml", additions: 1, deletions: 1, patch: "-timeout: 30\n+timeout: 60" }] },
      },
    });

    const provider = new GitHubProvider({ repo: "acme/app", token: "ghp_secret", fetch });
    const deploys = await provider.getDeploys({ start: "2026-09-01", end: "2026-09-30" });

    expect(deploys).toEqual([
      {
        repo: "acme/app",
        commitSha: "sha11",
        prNumber: 11,
        mergedAt: "2026-09-10T15:00:00.000Z",
        author: "dev11",
        title: "PR 11",
        body: undefined,
        url: "https://github.com/acme/app/pull/11",
        files: [{ path: "src/a.ts", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }],
      },
      {
        repo: "acme/app",
        commitSha: "hotfix",
        prNumber: null,
        mergedAt: "2026-09-15T08:05:00.000Z",
        author: "ops-bot",
        title: "Hotfix: bump timeout",
        body: "Urgent.",
        url: "https://github.com/acme/app/commit/hotfix",
        files: [{ path: "serverless.yml", additions: 1, deletions: 1, patch: "-timeout: 30\n+timeout: 60" }],
      },
    ]);
    // Stops paginating once PRs were last updated before the range.
    expect(calls.some((c) => c.path === "/page2")).toBe(false);
    expect(calls[0]!.headers.Authorization).toBe("Bearer ghp_secret");
  });

  it("validates the repo name", () => {
    expect(() => new GitHubProvider({ repo: "not a repo" })).toThrow(/owner\/name/);
  });
});

describe("GitHubClient", () => {
  it("retries after a secondary rate limit", async () => {
    const { fetch } = fakeFetch({
      "/x": [
        { status: 429, body: {}, headers: { "retry-after": "2" } },
        { body: { ok: true } },
      ],
    });
    const waits: number[] = [];
    const client = new GitHubClient({ fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await client.get("/x")).toEqual({ ok: true });
    expect(waits).toEqual([2000]);
  });

  it("explains auth failures without leaking the token", async () => {
    const { fetch } = fakeFetch({ "/x": { status: 401, body: { message: "Bad credentials" } } });
    const err = (await new GitHubClient({ fetch, token: "ghp_secret" }).get("/x").catch((e: unknown) => e)) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.message).toMatch(/GITHUB_TOKEN/);
    expect(err.message).not.toContain("ghp_secret");
  });

  it("parses the next link", () => {
    expect(parseNextLink('<https://a/2>; rel="next", <https://a/9>; rel="last"')).toBe("https://a/2");
    expect(parseNextLink('<https://a/9>; rel="last"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});
