# CommitCost

CommitCost connects cloud cost spikes to the commits that caused them. It pinpoints which PR made your AWS bill jump and why, and it warns you about cost regressions in pull requests before they're merged.

It has three parts that share one engine: a sync that pulls AWS Cost Explorer data and GitHub history, a dashboard that shows cost anomalies with their ranked suspect PRs, and a GitHub Action that comments on PRs with likely cost increases before they merge. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart (mock mode, no credentials)

Requires Node 20.9 or newer (Node 22 recommended; `.nvmrc` pins it, so `nvm install && nvm use` picks the right version). Check with `node -v`. On an older Node, `npm install` stops with an "Unsupported engine" error naming the required version, and `npm run demo` checks the Node version and installed dependencies before doing anything else. After switching Node versions, run `rm -rf node_modules && npm install`.

```sh
npm install
npm run demo
```

Then open http://localhost:3000.

`npm run demo` creates a local SQLite database in `.commitcost/`, generates 90 days of AWS costs and a fake GitHub history, stores them, runs anomaly detection and attribution over the stored data, and checks the results against the injected ground truth (also written to `.commitcost/mock-ground-truth.json`). It stops with an error if any injected commit isn't ranked #1. Otherwise it starts the dashboard on that data:

- **Overview:** daily cost per service with anomaly markers (▲ increase, ▼ decrease), spend tiles, and the top cost-impacting changes by monthly impact. Click a marker or a change to open the anomaly.
- **Anomaly:** the cost chart around the onset, ranked suspect PRs with confidence, the explanation, the diff lines that caused it, and whether the pre-merge PR check would have caught it.
- **Changes:** every merged PR with the anomalies it was blamed for and the PR check result.
- **PR check:** paste any `git diff` to see the warnings and the exact comment the GitHub Action would post.

`npm run demo:check` runs the same check without starting the dashboard (CI uses it) and prints each anomaly in the terminal. Example output for one anomaly:

```
▲ 2026-07-28  RDS app=api  +$85/day  +$2,538/mo  (7d, score 19.02)
   #1  82%  PR #128 Show line items on order history page ✓ injected cause
      RDS cost in app "api" rose $85/day (+47%) starting 2026-07-28, about $2,538/month extra.
      PR #128 "Show line items on order history page" by @dev-priya was merged 2 days before.
      Database query inside a loop (N+1) (services/api/src/routes/orders.ts:44): ...
   #2  12%  PR #127 Refactor order repository to use a query builder
   #3   9%  PR #130 Validate request body on teams endpoints
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run dashboard` | Start the dashboard on whatever is in the database (mock or synced) |
| `npm run demo:check` | Seed mock data, analyze and verify attribution in the terminal |
| `npm run seed` | Generate and store mock data without the summary |
| `npm run sync` | Pull real AWS costs and GitHub history (see below) |
| `npm run analyze` | Detect anomalies in stored data and rank suspect deploys |
| `npm test` | Run unit tests |
| `npm run build:web` | Production build of the dashboard (`npm start -w @commitcost/web` serves it) |
| `npm run build:action` | Rebuild `action/dist/index.cjs` after changing the action or engine |
| `npm run typecheck` | Type-check every package |
| `npm run db:schema:postgres` | Write a Postgres copy of the Prisma schema to `db/prisma/postgres/` |

## Mock data

The generator (`providers/src/mock/`) is deterministic for a given seed and end date. It produces:

- Daily costs for EC2, RDS, Lambda, S3, DynamoDB and data transfer, split by an `app` cost-allocation tag (`api`, `worker`, `web`, untagged). Costs include weekday/weekend seasonality, slow growth and noise.
- About 140 merged PRs with realistic diffs, mostly benign, plus decoy PRs that touch related files right before each spike.
- Injected cost changes, each caused by a specific commit:

| Change | Service | Effect |
| --- | --- | --- |
| Query inside a loop on the order history endpoint (N+1) | RDS | +$95/day, 2 days after merge |
| Lambda memory 512 MB → 3008 MB, timeout 30s → 300s | Lambda | +$115/day, same day |
| S3 cross-region replication for the uploads bucket | Data transfer + S3 | +$76/day, ramping over 3 days |
| Lambda memory right-sized to 1024 MB | Lambda | −$91/day |
| Worker instances m5.xlarge → m5.2xlarge | EC2 | +$150/day, 1 day after merge |
| Redis cache removed in front of DynamoDB lookups | DynamoDB | +$55/day, 1 day after merge |
| Crawler burst (no code cause) | Data transfer | +$85 for one day |

## Configuration

Copy `.env.example` to `.env` if you need to override anything. With no `COMMITCOST_DATABASE_URL`, CommitCost uses `.commitcost/commitcost.db`. It deliberately ignores `DATABASE_URL`, so a value exported for another project can't point it at the wrong database. If a schema change can't be applied to that default local database, `npm run demo` moves it aside (`.commitcost/commitcost.db.bak-*`) and starts fresh; mock data is regenerated and synced costs come back from the on-disk cache.

To use Postgres, run `npm run db:schema:postgres`, set `COMMITCOST_DATABASE_URL` to your Postgres URL, and point Prisma at `db/prisma/postgres/schema.prisma`.

## Hosted mode: companies connect their own AWS and GitHub

CommitCost can run as a multi-company service. People sign in with GitHub, create a workspace for their company, and connect:

- **AWS** by deploying a CloudFormation stack that creates a read-only IAM role (`ce:GetCostAndUsage` and `ce:GetTags` only). Only CommitCost's AWS principal can assume it, and only with the workspace's external ID. No AWS keys are created or stored.
- **GitHub** by installing the CommitCost GitHub App on the repos they choose (read-only contents, pull requests and metadata).

A worker (`npm run worker`) then syncs each workspace every 6 hours and re-runs attribution. Every row of cost, change and analysis data belongs to one workspace. Setting up the GitHub App, the AWS principal and hosting is covered in [docs/ONBOARDING.md](docs/ONBOARDING.md).

Without a GitHub App configured, the dashboard runs in **local mode**: no sign-in, one local user, and the Demo workspace, so `npm run demo` works exactly as before. An older local database is moved aside and recreated automatically, since workspaces changed the schema.

## Self-hosted: one workspace with your own credentials

The CLI can also sync a single workspace using credentials on your machine. Data goes into the `local` workspace (`--org <slug>` or `COMMITCOST_ORG` to change it).

1. **AWS.** CommitCost only needs read-only Cost Explorer access. Attach this policy to the user or role whose credentials you use:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "CommitCostReadOnlyCostExplorer",
         "Effect": "Allow",
         "Action": ["ce:GetCostAndUsage"],
         "Resource": "*"
       }
     ]
   }
   ```

   Credentials come from the standard AWS chain (`AWS_PROFILE`, access key env vars, SSO, or an instance role). Run it against the payer (management) account to see the whole organization's spend. To break costs down by team or app, activate a cost-allocation tag in the Billing console and set `COMMITCOST_TAG_KEY`.

2. **GitHub.** Create a fine-grained personal access token with read-only **Contents** and **Pull requests** access to the repository.

3. **Configure and run.**

   ```sh
   cp .env.example .env   # then fill in GITHUB_TOKEN, GITHUB_REPO and optionally COMMITCOST_TAG_KEY
   npm run sync           # pulls 90 days of costs and merged PRs
   npm run analyze        # finds anomalies and ranks the PRs behind them (in the local workspace)
   ```

`sync` is incremental: later runs only fetch days since the last sync (re-fetching the last 3, which AWS still revises). Cost Explorer charges $0.01 per request, so responses for settled date ranges are cached on disk in `.commitcost/cache/` and never re-requested; `sync` prints how many requests it made.

### Optional: LLM explanations

The heuristic explanations work without any LLM. To have Claude rewrite the top suspect's explanation from the actual diff, set `COMMITCOST_LLM=anthropic` and `ANTHROPIC_API_KEY`. Only the suspect PR's diff (capped at 12k characters) and the cost numbers are sent. To add another provider, implement the `Explainer` interface in `engine/src/explain.ts`.

### How attribution works

- **Anomalies:** for each service, every day is compared with the median of the previous 14 days of the same kind (weekdays against weekdays, weekends against weekends), using a MAD-based spread. A day is flagged when it is at least 4 robust standard deviations away, at least $10, and at least 10% off. Consecutive flagged days form one anomaly. If cost stays at the new level it's a step change, with monthly impact = daily delta × 30. If it returns to baseline it's a blip.
- **Candidates:** deploys merged from 3 days before the onset through the onset day.
- **Scoring:** 30% timing (closer is higher) and 70% relevance. Relevance comes from diff detectors that recognize cost patterns for the spiking service: queries inside loops, removed caches or batching, instance size and count changes, Lambda memory and concurrency, schedule frequency, cross-region replication, and removed S3 lifecycle rules. Files whose paths merely suggest the service count as weak evidence.
- **Confidence** is lowered when a runner-up scores close behind, when nothing in the diff relates to the service, and for blips.

## Installing the GitHub Action

The Action reviews each PR's diff with the same detectors the attribution engine uses and posts one comment listing likely cost increases: the file and line, why it costs money, a rough monthly impact with its assumptions, and a suggested fix. On later pushes it edits that comment instead of adding new ones, and it replaces it with an all-clear when the risky code is gone. Test, vendored and lock files are skipped, and only findings at or above `min-confidence` are reported, to keep false positives down. It needs no AWS access.

Add `.github/workflows/commitcost.yml` to the repo you want checked:

```yaml
name: CommitCost
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  cost-check:
    runs-on: ubuntu-latest
    steps:
      - uses: John-Almos/CommitCost/action@main
        with:
          min-confidence: "0.6"
          # Optional: current monthly spend per service, to bound estimates.
          # service-spend: '{"EC2": 4200, "Lambda": 900}'
```

| Input | Default | Meaning |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Reads PR files and writes the comment |
| `min-confidence` | `0.6` | Report findings at or above this confidence (0 to 1) |
| `service-spend` | none | JSON of monthly spend per service, used to scale estimates |
| `dry-run` | `false` | Write the review to the job summary only, never comment |

The `warnings` output is the number of findings. PRs from forks get a read-only token, so on those the Action logs a warning and writes the job summary instead of commenting. Try it without installing anything on the dashboard's **PR check** page.

## Repository layout

```
core/        Domain types, provider interfaces, date helpers
db/          Prisma schema (SQLite locally, Postgres in production) and repository functions
providers/   Data sources: mock/, aws/ (Cost Explorer), github/ (REST), llm/ (optional Claude explainer)
platform/    Hosted mode: AWS role assumption, GitHub App auth, per-workspace sync and the worker
cli/         demo, seed, sync, analyze, sync-org and cfn-template commands
engine/      Anomaly detection, diff detectors, attribution scoring (pure, no I/O)
action/      GitHub Action for pre-merge cost warnings (bundled to action/dist/index.cjs)
web/         Next.js dashboard
```
