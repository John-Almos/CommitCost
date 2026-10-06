import { GitHubApp, readPlatformConfig, type PlatformConfig } from "@commitcost/platform";

const g = globalThis as unknown as { __commitcostConfig?: PlatformConfig };

/** Platform settings from the environment, read once per server process. */
export function platform(): PlatformConfig {
  return (g.__commitcostConfig ??= readPlatformConfig());
}

export function githubApp(): GitHubApp | null {
  const c = platform().github;
  return c ? new GitHubApp(c) : null;
}

export const isLocalMode = () => platform().authMode === "local";
