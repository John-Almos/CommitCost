import { readFileSync } from "node:fs";

/**
 * Settings for running CommitCost as a hosted, multi-company service. Every
 * value here belongs to the CommitCost operator, never to a customer:
 * customers connect through an IAM role and a GitHub App installation, and
 * nothing secret of theirs is stored.
 */
export interface PlatformConfig {
  /** Public base URL of the web app, no trailing slash. */
  appUrl: string;
  /** Signs OAuth state and install links. */
  secret: string;
  /** "github": Sign in with GitHub. "local": single local user, for development and mock mode. */
  authMode: "github" | "local";
  github: GitHubAppConfig | null;
  aws: {
    /** ARN of the IAM role or user CommitCost itself runs as. Customer roles trust only this principal. */
    principalArn: string | null;
    /** S3 URL of the hosted CloudFormation template, for one-click "Launch stack". */
    templateUrl: string | null;
  };
  sync: { intervalHours: number; days: number };
}

export interface GitHubAppConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret: string | null;
  apiUrl: string;
  webUrl: string;
}

const DEV_SECRET = "commitcost-local-development-secret-do-not-use";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readPrivateKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_APP_PRIVATE_KEY) return env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (env.GITHUB_APP_PRIVATE_KEY_PATH) return readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  return undefined;
}

/** Reads platform settings. Lists everything missing at once and never echoes secret values. */
export function readPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const appUrl = (env.COMMITCOST_URL || "http://localhost:3000").replace(/\/+$/, "");
  const production = env.NODE_ENV === "production";

  const appKeys = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"] as const;
  const present = appKeys.filter((k) => env[k]);
  const privateKey = readPrivateKey(env);
  let github: GitHubAppConfig | null = null;
  if (present.length > 0 || privateKey) {
    const missing: string[] = appKeys.filter((k) => !env[k]);
    if (!privateKey) missing.push("GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH)");
    if (missing.length) throw new ConfigError(`GitHub App is partly configured. Missing:\n  - ${missing.join("\n  - ")}\nSee docs/ONBOARDING.md.`);
    github = {
      appId: env.GITHUB_APP_ID!,
      slug: env.GITHUB_APP_SLUG!,
      clientId: env.GITHUB_APP_CLIENT_ID!,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET!,
      privateKey: privateKey!,
      webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET || null,
      apiUrl: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
      webUrl: (env.GITHUB_WEB_URL || "https://github.com").replace(/\/+$/, ""),
    };
  }

  // Local mode signs everyone in as one local user. Never allow that on a
  // production deployment unless the operator opts in explicitly.
  const allowLocal = !production || env.COMMITCOST_ALLOW_LOCAL_MODE === "1";
  if (!github && !allowLocal) {
    throw new ConfigError("Sign-in is not configured. Set the GITHUB_APP_* variables (see docs/ONBOARDING.md), or COMMITCOST_ALLOW_LOCAL_MODE=1 for a private single-user install.");
  }

  const secret = env.COMMITCOST_SECRET || "";
  if (production && github && secret.length < 32) throw new ConfigError("COMMITCOST_SECRET must be set to at least 32 random characters.");

  const intervalHours = Number(env.COMMITCOST_SYNC_INTERVAL_HOURS ?? 6);
  if (!Number.isFinite(intervalHours) || intervalHours < 1) throw new ConfigError("COMMITCOST_SYNC_INTERVAL_HOURS must be at least 1");
  const days = Number(env.COMMITCOST_DAYS ?? 90);
  if (!Number.isInteger(days) || days < 21 || days > 365) throw new ConfigError("COMMITCOST_DAYS must be a whole number between 21 and 365");

  const principalArn = env.COMMITCOST_AWS_PRINCIPAL_ARN || null;
  if (principalArn && !/^arn:aws[\w-]*:(iam|sts)::\d{12}:/.test(principalArn)) {
    throw new ConfigError("COMMITCOST_AWS_PRINCIPAL_ARN must be an IAM role or user ARN, e.g. arn:aws:iam::123456789012:role/commitcost");
  }

  return {
    appUrl,
    secret: secret || DEV_SECRET,
    authMode: github ? "github" : "local",
    github,
    aws: { principalArn, templateUrl: env.COMMITCOST_CFN_TEMPLATE_URL || null },
    sync: { intervalHours, days },
  };
}
