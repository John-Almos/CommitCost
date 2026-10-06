/** Minimal GitHub REST client: auth, pagination, and rate-limit handling. */

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** For tests: replaces real waiting on rate limits. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

const MAX_WAIT_MS = 60_000;

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  requestCount = 0;

  constructor(private readonly options: GitHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 3;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "commitcost",
    };
    if (this.options.token) h.Authorization = `Bearer ${this.options.token}`;
    return h;
  }

  /** GET one resource. `path` is relative to the API root, e.g. "/repos/o/r". */
  async get<T>(path: string): Promise<T> {
    return (await this.request<T>(this.url(path))).body;
  }

  /** POST a JSON body (used for minting GitHub App installation tokens). */
  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return (await this.request<T>(this.url(path), { method: "POST", body: JSON.stringify(body) })).body;
  }

  /**
   * Iterates pages via the Link header. Return false from `onPage` to stop
   * early (e.g. once results are older than the range being synced).
   */
  async paginate<T>(path: string, onPage: (items: T[]) => boolean | void): Promise<void> {
    let url: string | null = this.url(path);
    while (url) {
      const res: { body: T[]; next: string | null } = await this.request<T[]>(url);
      if (onPage(res.body) === false) return;
      url = res.next;
    }
  }

  private url(path: string): string {
    return path.startsWith("http") ? path : `${this.baseUrl}${path}`;
  }

  private async request<T>(url: string, init: { method?: string; body?: string } = {}): Promise<{ body: T; next: string | null }> {
    for (let attempt = 0; ; attempt++) {
      this.requestCount++;
      const headers = this.headers();
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      const res = await this.fetchImpl(url, { ...init, headers });
      if (res.ok) {
        return { body: (await res.json()) as T, next: parseNextLink(res.headers.get("link")) };
      }

      const wait = rateLimitWaitMs(res.status, res.headers);
      if (wait !== null && attempt < this.maxRetries && wait <= MAX_WAIT_MS) {
        await this.sleep(wait);
        continue;
      }
      // Never include request headers here: they carry the token.
      const detail = await res.text().catch(() => "");
      const hint =
        res.status === 401
          ? " Check that GITHUB_TOKEN is set and valid."
          : res.status === 404
            ? " Check GITHUB_REPO and that the token can read this repository."
            : wait !== null
              ? " GitHub rate limit reached; try again later."
              : "";
      throw new GitHubApiError(`GitHub API ${res.status} for ${url.replace(this.baseUrl, "")}.${hint} ${detail.slice(0, 200)}`.trim(), res.status);
    }
  }
}

export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

/** Returns how long to wait before retrying, or null if this isn't a rate limit. */
function rateLimitWaitMs(status: number, headers: { get(name: string): string | null }): number | null {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) return Number(retryAfter) * 1000;
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - Date.now()) + 1000;
  }
  return status === 429 ? 5000 : null;
}
