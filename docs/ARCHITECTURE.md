# Architecture

## Packages

npm workspaces, TypeScript run directly with `tsx` and `vitest` (no build step). Each package's `main` points at `src/index.ts`.

| Package | Depends on | Responsibility |
| --- | --- | --- |
| `@commitcost/core` | none | Domain types (`CostRecord`, `Deploy`, `CostAnomaly`, `Attribution`), `CostProvider` / `VcsProvider` interfaces, date helpers |
| `@commitcost/db` | core | Prisma schema and client, idempotent save/load functions |
| `@commitcost/providers` | core | `mock/` now; `aws/` (Cost Explorer) and `github/` (REST) in Phase 2 |
| `@commitcost/cli` | core, db, providers | `seed`, `demo`; later `sync` and `analyze` |
| `engine/` (Phase 3) | core | Anomaly detection, candidate search, relevance scoring, optional LLM explanation. Pure functions, no I/O |
| `action/` (Phase 4) | core, engine | Diff-pattern detectors and the PR comment |
| `web/` (Phase 5) | core, db, engine | Next.js dashboard |

Data flows one way: providers produce domain objects, db stores them, the engine reads domain objects and returns anomalies and attributions, and db stores those for the dashboard.

Adding GCP or Azure means a new `CostProvider` and mapping its service names onto `Service`. Nothing in the engine changes.

## Data model

See `db/prisma/schema.prisma` for the full definitions.

**CostRecord**: one day of spend for one service and one cost-allocation tag value. This mirrors a Cost Explorer `GetCostAndUsage` call grouped by `SERVICE` and `TAG`. Unique on `(date, provider, accountId, service, tagKey, tagValue)` so re-syncs overwrite rather than duplicate. Tag fields use `""` rather than NULL so the unique key behaves the same on SQLite and Postgres.

**Deploy**: a merged PR or direct push to the default branch: commit SHA, PR number, merge time, author, title, body. Unique on `(repo, commitSha)`.

**DeployFile**: one changed file per row, with additions, deletions and the patch. Kept as a table rather than a string list so the engine can score relevance per file and the dashboard can show diff snippets.

**CostAnomaly**: the cost change being explained: service, tag, onset day, baseline, observed, daily delta, direction and a robust deviation score.

**Attribution**: links an anomaly to one suspect deploy, with rank (1 is most likely), confidence (0 to 1), a score breakdown (`timing`, `relevance`, and so on), the explanation and its source (heuristic or LLM), and estimated monthly impact (daily delta × 30). An anomaly has one row per candidate, so "links a cost change to one or more deploys" is a ranked list.

## SQLite and Postgres

Prisma can't switch providers from an environment variable, so `db/prisma/schema.prisma` targets SQLite and avoids provider-specific features (no enums, no scalar lists). `npm run db:schema:postgres` writes a copy with only the provider changed.

## Mock mode

`providers/src/mock/` is a pure function of `(seed, endDate, days)`. It reads no environment variables. The scenario (`scenario.ts`) defines each injected change with its diff, lag, and effect on cost, plus decoy PRs placed in each spike's lookback window and a blip with no code cause. Tests check that each spike is visible above noise and that its commit sits 0 to 3 days before onset. Phase 3 tests will assert the engine ranks each injected commit #1.
