# Architecture

## Packages

npm workspaces, TypeScript run directly with `tsx` and `vitest`. Each package's `main` points at `src/index.ts`. Two things are built: the Action is bundled with esbuild into `action/dist/index.cjs` (committed, since GitHub runs it as is, and a test fails if it is stale), and the dashboard is built by Next.js with webpack, whose `extensionAlias` resolves the workspaces' `./x.js` imports to `.ts` sources.

| Package | Depends on | Responsibility |
| --- | --- | --- |
| `@commitcost/core` | none | Domain types (`CostRecord`, `Deploy`, `CostAnomaly`, `Attribution`), `CostProvider` / `VcsProvider` interfaces, date helpers |
| `@commitcost/db` | core | Prisma schema and client, idempotent save/load functions |
| `@commitcost/providers` | core, engine (types) | `mock/`, `aws/` (Cost Explorer with on-disk cache), `github/` (REST with pagination and rate-limit retries), `llm/` (Claude explainer) |
| `@commitcost/engine` | core | Anomaly detection, diff detectors, candidate scoring, the `Explainer` interface. Pure functions, no I/O |
| `@commitcost/platform` | core, db, providers, engine | Hosted mode: platform config, the customer IAM role template and `sts:AssumeRole` checks, GitHub App auth (JWT, installation tokens, OAuth), per-workspace sync, and the queue worker |
| `@commitcost/cli` | all | `demo`, `seed`, `sync`, `analyze` |
| `@commitcost/action` | core, engine | PR review (`reviewFiles`), impact estimates, the consolidated comment, and the Action entry point |
| `@commitcost/web` | core, db, engine, action, platform | Next.js dashboard: overview, anomaly detail, changes, PR check |

Data flows one way: providers produce domain objects, db stores them, the engine reads domain objects and returns anomalies and attributions, and db stores those for the dashboard.

Adding GCP or Azure means a new `CostProvider` and mapping its service names onto `Service`. Nothing in the engine changes.

## Data model

See `db/prisma/schema.prisma` for the full definitions.

**Organization** (a workspace) owns everything below. `CostRecord`, `Deploy` and `CostAnomaly` carry `orgId` and their unique keys start with it; every repository function takes an `orgId`, and the web app takes it from the signed-in user's current workspace, never from the request. `User`, `Membership` (owner or member), `Invite` and `Session` (hashed tokens) cover sign-in. `AwsConnection` stores a role ARN per account, `GitHubInstallation` and `TrackedRepo` store which repos to read; none of them hold a secret. `SyncRun` is both the sync history and the job queue.

**CostRecord**: one day of spend for one service and one cost-allocation tag value. This mirrors a Cost Explorer `GetCostAndUsage` call grouped by `SERVICE` and `TAG`. Unique on `(date, provider, accountId, service, tagKey, tagValue)` so re-syncs overwrite rather than duplicate. Tag fields use `""` rather than NULL so the unique key behaves the same on SQLite and Postgres.

**Deploy**: a merged PR or direct push to the default branch: commit SHA, PR number, merge time, author, title, body. Unique on `(repo, commitSha)`.

**DeployFile**: one changed file per row, with additions, deletions and the patch. Kept as a table rather than a string list so the engine can score relevance per file and the dashboard can show diff snippets.

**CostAnomaly**: the cost change being explained: service, the tag it's concentrated in, onset day, duration, baseline, observed, daily delta, direction, a robust deviation score, whether it persisted (step change or blip), and estimated monthly impact. Anomalies are derived data: each `analyze` run replaces them.

**Attribution**: links an anomaly to one suspect deploy, with rank (1 is most likely), confidence (0 to 1), a score breakdown (`timing`, `relevance`, `total`), the diff evidence (file, line, snippet), the explanation and its source (heuristic or LLM), and estimated monthly impact (daily delta × 30). An anomaly has one row per candidate, so "links a cost change to one or more deploys" is a ranked list.

## SQLite and Postgres

Prisma can't switch providers from an environment variable, so `db/prisma/schema.prisma` targets SQLite and avoids provider-specific features (no enums, no scalar lists). `npm run db:schema:postgres` writes a copy with only the provider changed.

## Mock mode

`providers/src/mock/` is a pure function of `(seed, endDate, days)`. It reads no environment variables. The scenario (`scenario.ts`) defines each injected change with its diff, lag, and effect on cost, plus decoy PRs placed in each spike's lookback window and a blip with no code cause. Tests check that each spike is visible above noise and that its commit sits 0 to 3 days before onset. Engine tests (`engine/src/mock.test.ts`) assert that every injected change is detected with its commit ranked #1 across several noise seeds, that the no-cause blip gets low confidence, and that nothing else is flagged.

## Diff detectors

`engine/src/diff/` parses unified-diff patches and runs detectors that each return findings with file, line, affected services, direction, confidence, why it costs money, a suggested fix and, where the diff states both values, a cost ratio. Attribution uses them to score relevance. The GitHub Action runs the same detectors on PR diffs and adds a rough monthly impact from `engine/src/impact.ts` (list prices plus stated assumptions), so a pattern that explains a past spike is also what gets flagged before merge.

Detectors work line by line, using indentation for loop scope, so they handle JS/TS, Python, YAML, HCL and CDK without a parser per language. The trade-off is that a loop body which runs past the end of a diff hunk is cut at the hunk boundary.

## Dashboard

`web/` is a Next.js App Router app. Pages are server components that read the database through `web/lib/data.ts`; the only client components are the SVG cost chart (hover crosshair, clickable anomaly markers, a table view for each chart) and the PR check form, which calls a server action that runs `reviewFiles` and `renderComment` from `@commitcost/action`. It reads the same `DATABASE_URL` as the CLI (default `.commitcost/commitcost.db`), so it shows mock data after `npm run demo` and real data after `npm run sync` and `npm run analyze`.
