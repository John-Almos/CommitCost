import type { DateRange, Deploy, DeployFile, VcsProvider } from "@commitcost/core";
import { GitHubClient, type GitHubClientOptions } from "./client.js";

interface GhPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  updated_at: string;
  merge_commit_sha: string | null;
  user: { login: string } | null;
}

interface GhFile {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GhCommitSummary {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } | null; committer: { date: string } | null };
  author: { login: string } | null;
}

interface GhCommit extends GhCommitSummary {
  files?: GhFile[];
}

export interface GitHubProviderOptions extends GitHubClientOptions {
  /** "owner/name" */
  repo: string;
  /** Defaults to the repository's default branch. */
  branch?: string;
  /** Include commits pushed straight to the branch (not via a PR). Default true. */
  includeDirectPushes?: boolean;
  client?: GitHubClient;
}

/** Large generated diffs add noise and storage; keep each patch bounded. */
const MAX_PATCH_CHARS = 20_000;

/**
 * Merged PRs and direct pushes on the default branch, via the GitHub REST
 * API. Uses a personal access token for the MVP (read access to contents and
 * pull requests is enough).
 */
export class GitHubProvider implements VcsProvider {
  readonly name = "github";
  readonly client: GitHubClient;

  constructor(private readonly options: GitHubProviderOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error(`GITHUB_REPO must look like owner/name, got "${options.repo}"`);
    this.client = options.client ?? new GitHubClient(options);
  }

  async getDeploys(range: DateRange): Promise<Deploy[]> {
    const repo = this.options.repo;
    const branch = this.options.branch ?? (await this.client.get<{ default_branch: string }>(`/repos/${repo}`)).default_branch;
    const from = `${range.start}T00:00:00Z`;
    const to = `${range.end}T23:59:59Z`;

    const pulls = await this.mergedPulls(repo, branch, from, to);
    const deploys: Deploy[] = [];
    for (const pr of pulls) {
      deploys.push({
        repo,
        commitSha: pr.merge_commit_sha!,
        prNumber: pr.number,
        mergedAt: new Date(pr.merged_at!).toISOString(),
        author: pr.user?.login ?? "unknown",
        title: pr.title,
        body: pr.body ?? undefined,
        url: pr.html_url,
        files: await this.pullFiles(repo, pr.number),
      });
    }

    if (this.options.includeDirectPushes ?? true) {
      deploys.push(...(await this.directPushes(repo, branch, from, to, new Set(deploys.map((d) => d.commitSha)))));
    }
    return deploys.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  }

  /**
   * The CODEOWNERS file from the default branch, from any of the three places
   * GitHub looks, or null when the repo has none.
   */
  async getCodeowners(): Promise<string | null> {
    const repo = this.options.repo;
    for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
      try {
        const file = await this.client.get<{ content?: string; encoding?: string }>(`/repos/${repo}/contents/${path}`);
        if (file.content && file.encoding === "base64") return Buffer.from(file.content, "base64").toString("utf8");
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
    }
    return null;
  }

  private async mergedPulls(repo: string, branch: string, from: string, to: string): Promise<GhPull[]> {
    const out: GhPull[] = [];
    const base = encodeURIComponent(branch);
    // Sorted by last update, newest first. A PR merged in range was updated at
    // or after its merge, so we can stop once updates fall before the range.
    await this.client.paginate<GhPull>(
      `/repos/${repo}/pulls?state=closed&base=${base}&sort=updated&direction=desc&per_page=100`,
      (page) => {
        for (const pr of page) {
          if (pr.merged_at && pr.merge_commit_sha && pr.merged_at >= from && pr.merged_at <= to) out.push(pr);
        }
        const oldest = page.at(-1)?.updated_at;
        return !(page.length === 0 || (oldest !== undefined && oldest < from));
      },
    );
    return out;
  }

  private async pullFiles(repo: string, number: number): Promise<DeployFile[]> {
    const files: DeployFile[] = [];
    await this.client.paginate<GhFile>(`/repos/${repo}/pulls/${number}/files?per_page=100`, (page) => {
      files.push(...page.map(toDeployFile));
    });
    return files;
  }

  private async directPushes(repo: string, branch: string, from: string, to: string, prShas: Set<string>): Promise<Deploy[]> {
    const candidates: GhCommitSummary[] = [];
    await this.client.paginate<GhCommitSummary>(
      `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${from}&until=${to}&per_page=100`,
      (page) => {
        candidates.push(...page.filter((c) => !prShas.has(c.sha)));
      },
    );

    const out: Deploy[] = [];
    for (const c of candidates) {
      // Rebase merges put several commits on the branch for one PR; skip any
      // commit GitHub associates with a PR so each change is counted once.
      const pulls = await this.client.get<unknown[]>(`/repos/${repo}/commits/${c.sha}/pulls`);
      if (pulls.length > 0) continue;
      const full = await this.client.get<GhCommit>(`/repos/${repo}/commits/${c.sha}`);
      out.push({
        repo,
        commitSha: c.sha,
        prNumber: null,
        mergedAt: new Date(c.commit.committer?.date ?? c.commit.author?.date ?? from).toISOString(),
        author: c.author?.login ?? c.commit.author?.name ?? "unknown",
        title: c.commit.message.split("\n")[0]!,
        body: c.commit.message.split("\n").slice(1).join("\n").trim() || undefined,
        url: c.html_url,
        files: (full.files ?? []).map(toDeployFile),
      });
    }
    return out;
  }
}

function toDeployFile(f: GhFile): DeployFile {
  return {
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch === undefined ? undefined : f.patch.slice(0, MAX_PATCH_CHARS),
  };
}
