import { generateKeyPairSync, createVerify } from "node:crypto";
import type { FetchLike } from "@commitcost/providers";
import { describe, expect, it } from "vitest";
import type { GitHubAppConfig } from "./config.js";
import { createAppJwt, GitHubApp } from "./githubApp.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const config: GitHubAppConfig = {
  appId: "4242",
  slug: "commitcost-test",
  clientId: "Iv1.client",
  clientSecret: "client-secret",
  privateKey: pem,
  webhookSecret: null,
  apiUrl: "https://api.github.test",
  webUrl: "https://github.test",
};

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };

function fakeFetch(routes: Record<string, (call: Call) => { status?: number; body: unknown; link?: string }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const call = { url, ...init };
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const res = key ? routes[key]!(call) : { status: 404, body: { message: "Not Found" } };
    const status = res.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: { get: (n: string) => (n === "link" ? (res.link ?? null) : null) },
      json: async () => res.body,
      text: async () => JSON.stringify(res.body),
    };
  };
  return { fetch, calls };
}

describe("createAppJwt", () => {
  it("is an RS256 JWT for the App, valid under ten minutes", () => {
    const jwt = createAppJwt("4242", pem, 1_700_000_000_000);
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(claims.iss).toBe("4242");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });
});

describe("GitHubApp", () => {
  it("builds sign-in and install links", () => {
    const app = new GitHubApp(config);
    const auth = new URL(app.authorizeUrl("https://cc.test/auth/github/callback", "st"));
    expect(auth.origin + auth.pathname).toBe("https://github.test/login/oauth/authorize");
    expect(auth.searchParams.get("client_id")).toBe("Iv1.client");
    expect(auth.searchParams.get("state")).toBe("st");
    expect(app.installUrl("a.b")).toBe("https://github.test/apps/commitcost-test/installations/new?state=a.b");
  });

  it("exchanges an OAuth code and reports GitHub's error text", async () => {
    const { fetch, calls } = fakeFetch({ "/login/oauth/access_token": () => ({ body: { access_token: "ghu_user" } }) });
    const app = new GitHubApp(config, { fetch });
    expect(await app.exchangeCode("code1", "https://cc.test/cb")).toBe("ghu_user");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ client_id: "Iv1.client", client_secret: "client-secret", code: "code1" });

    const bad = new GitHubApp(config, { fetch: fakeFetch({ "/login/oauth/access_token": () => ({ body: { error: "bad_verification_code", error_description: "The code is incorrect" } }) }).fetch });
    await expect(bad.exchangeCode("x", "y")).rejects.toThrow(/The code is incorrect/);
  });

  it("only accepts installations the signed-in user can access", async () => {
    const { fetch, calls } = fakeFetch({
      "/user/installations?per_page=100&page=2": () => ({ body: { total_count: 3, installations: [{ id: 30 }] } }),
      "/user/installations": () => ({ body: { total_count: 3, installations: [{ id: 10 }, { id: 20 }] }, link: '<https://api.github.test/user/installations?per_page=100&page=2>; rel="next"' }),
    });
    const app = new GitHubApp(config, { fetch });
    expect(await app.userCanAccessInstallation("ghu_user", 30)).toBe(true);
    expect(calls.every((c) => c.headers?.Authorization === "Bearer ghu_user")).toBe(true);
    expect(await app.userCanAccessInstallation("ghu_user", 99)).toBe(false);
  });

  it("mints installation tokens with the App JWT and lists non-archived repos", async () => {
    const { fetch, calls } = fakeFetch({
      "/app/installations/7/access_tokens": () => ({ status: 201, body: { token: "ghs_install" } }),
      "/installation/repositories": () => ({
        body: {
          total_count: 3,
          repositories: [
            { id: 2, full_name: "acme/web", default_branch: "main", private: true, archived: false },
            { id: 1, full_name: "acme/api", default_branch: "trunk", private: true, archived: false },
            { id: 3, full_name: "acme/old", default_branch: "master", private: false, archived: true },
          ],
        },
      }),
    });
    const app = new GitHubApp(config, { fetch });
    const repos = await app.listInstallationRepos(7);
    expect(repos.map((r) => r.full_name)).toEqual(["acme/api", "acme/web"]);
    const mint = calls.find((c) => c.url.includes("access_tokens"))!;
    expect(mint.method).toBe("POST");
    expect(mint.headers?.Authorization).toMatch(/^Bearer ey/);
    expect(calls.find((c) => c.url.includes("/installation/repositories"))!.headers?.Authorization).toBe("Bearer ghs_install");
  });
});
