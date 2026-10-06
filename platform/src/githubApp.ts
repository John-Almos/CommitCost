import { createSign } from "node:crypto";
import { GitHubClient, type FetchLike } from "@commitcost/providers";
import type { GitHubAppConfig } from "./config.js";

/** RS256 JWT that authenticates as the App itself (valid 9 minutes; GitHub allows 10). */
export function createAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // iat is backdated to tolerate clock drift, as GitHub recommends.
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 9 * 60, iss: appId })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${sig}`;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface Installation {
  id: number;
  account: { login: string; type: string } | null;
  suspended_at: string | null;
}

export interface InstallationRepo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
}

/**
 * Everything CommitCost does as a GitHub App: user sign-in (OAuth through the
 * App's client ID), checking who owns an installation, minting short-lived
 * installation tokens, and listing the repos an installation can read.
 */
export class GitHubApp {
  private readonly fetchImpl: FetchLike;

  constructor(
    readonly config: GitHubAppConfig,
    private readonly opts: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  private client(token: string): GitHubClient {
    return new GitHubClient({ token, baseUrl: this.config.apiUrl, fetch: this.fetchImpl });
  }

  /** Where "Sign in with GitHub" sends the browser. */
  authorizeUrl(redirectUri: string, state: string): string {
    const q = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: redirectUri, state, allow_signup: "true" });
    return `${this.config.webUrl}/login/oauth/authorize?${q}`;
  }

  /** Where "Connect GitHub" sends the browser to install the App. */
  installUrl(state: string): string {
    return `${this.config.webUrl}/apps/${encodeURIComponent(this.config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** Exchanges an OAuth `code` for a user access token. The token is used once and not stored. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const res = await this.fetchImpl(`${this.config.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "commitcost" },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, redirect_uri: redirectUri }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`GitHub sign-in failed: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`);
    }
    return body.access_token;
  }

  getUser(userToken: string): Promise<GitHubUser> {
    return this.client(userToken).get<GitHubUser>("/user");
  }

  /**
   * True if the signed-in user can access this installation. GitHub's setup
   * redirect carries `installation_id` in the query string, so anyone could
   * forge one; this check is what stops a user from attaching someone else's
   * installation to their workspace.
   */
  async userCanAccessInstallation(userToken: string, installationId: number): Promise<boolean> {
    let found = false;
    await this.client(userToken).paginate<Installation>("/user/installations?per_page=100", (page) => {
      // The endpoint wraps results: { total_count, installations: [...] }.
      const list = Array.isArray(page) ? page : ((page as unknown as { installations?: Installation[] }).installations ?? []);
      if (list.some((i) => i.id === installationId)) found = true;
      return !found && list.length > 0;
    });
    return found;
  }

  private appClient(): GitHubClient {
    return this.client(createAppJwt(this.config.appId, this.config.privateKey, this.opts.now?.()));
  }

  getInstallation(installationId: number): Promise<Installation> {
    return this.appClient().get<Installation>(`/app/installations/${installationId}`);
  }

  /** A token scoped to one installation, valid for an hour. Minted per sync, never stored. */
  async installationToken(installationId: number): Promise<string> {
    const res = await this.appClient().post<{ token: string }>(`/app/installations/${installationId}/access_tokens`);
    return res.token;
  }

  /** Repositories the installation was granted, excluding archived ones. */
  async listInstallationRepos(installationId: number): Promise<InstallationRepo[]> {
    const client = this.client(await this.installationToken(installationId));
    const repos: InstallationRepo[] = [];
    await client.paginate<InstallationRepo>("/installation/repositories?per_page=100", (page) => {
      const list = Array.isArray(page) ? page : ((page as unknown as { repositories?: InstallationRepo[] }).repositories ?? []);
      repos.push(...list.filter((r) => !r.archived));
      return list.length > 0;
    });
    return repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
  }
}
