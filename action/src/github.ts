/** The few GitHub REST calls the Action needs, over fetch. */

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface PrFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface IssueComment {
  id: number;
  body?: string;
  user?: { type?: string; login?: string } | null;
}

export class GitHub {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch,
    private readonly api = "https://api.github.com",
  ) {}

  private async call<T>(method: string, url: string, body?: unknown): Promise<{ data: T; next: string | null }> {
    const res = await this.fetchImpl(url.startsWith("http") ? url : `${this.api}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "commitcost-action",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw Object.assign(new Error(`GitHub ${method} ${url.replace(this.api, "")} failed with ${res.status}: ${detail.slice(0, 200)}`), { status: res.status });
    }
    const next = res.headers.get("link")?.match(/<([^>]+)>\s*;\s*rel="next"/)?.[1] ?? null;
    return { data: (await res.json()) as T, next };
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = path;
    while (url) {
      const page: { data: T[]; next: string | null } = await this.call<T[]>("GET", url);
      out.push(...page.data);
      url = page.next;
    }
    return out;
  }

  listPrFiles(repo: string, pr: number): Promise<PrFile[]> {
    return this.all<PrFile>(`/repos/${repo}/pulls/${pr}/files?per_page=100`);
  }

  listComments(repo: string, pr: number): Promise<IssueComment[]> {
    return this.all<IssueComment>(`/repos/${repo}/issues/${pr}/comments?per_page=100`);
  }

  async createComment(repo: string, pr: number, body: string): Promise<void> {
    await this.call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  }

  async updateComment(repo: string, id: number, body: string): Promise<void> {
    await this.call("PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
  }
}
