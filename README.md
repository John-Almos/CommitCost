# CommitCost

CommitCost connects cloud cost spikes to the commits that caused them. It pinpoints which PR made your AWS bill jump and why, and it warns you about cost regressions in pull requests before they're merged.

> **Status:** Phase 1 of 5 (data model and mock mode). Real AWS and GitHub integrations, the attribution engine, the GitHub Action, and the dashboard land in later phases. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart (mock mode, no credentials)

Requires Node 20 or newer.

```sh
npm install
npm run demo
```

`npm run demo` creates a local SQLite database in `.commitcost/`, generates 90 days of AWS costs and a fake GitHub history, stores them, and prints per-service cost charts with the injected spikes and the commits that caused them. The ground truth is written to `.commitcost/mock-ground-truth.json`.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run seed` | Generate and store mock data without the summary |
| `npm test` | Run unit tests |
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

Copy `.env.example` to `.env` if you need to override anything. With no `DATABASE_URL`, CommitCost uses `.commitcost/commitcost.db`.

To use Postgres, run `npm run db:schema:postgres`, set `DATABASE_URL` to your Postgres URL, and point Prisma at `db/prisma/postgres/schema.prisma`.

## Connecting real AWS and GitHub (Phase 2)

Coming in Phase 2. CommitCost only ever needs read-only AWS access. This is the minimal IAM policy it will require:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CommitCostReadOnlyCostExplorer",
      "Effect": "Allow",
      "Action": ["ce:GetCostAndUsage", "ce:GetTags"],
      "Resource": "*"
    }
  ]
}
```

Credentials come from the standard AWS chain (environment variables or an AWS profile). GitHub access uses a personal access token with read-only access to the repository's contents and pull requests. Never commit credentials: `.env` is git-ignored.

## Installing the GitHub Action (Phase 4)

Coming in Phase 4.

## Repository layout

```
core/        Domain types, provider interfaces, date helpers
db/          Prisma schema (SQLite locally, Postgres in production) and repository functions
providers/   Data sources: mock now; aws/ and github/ in Phase 2
cli/         `seed` and `demo` commands
engine/      Phase 3: anomaly detection, attribution, diff analysis
action/      Phase 4: GitHub Action for pre-merge cost warnings
web/         Phase 5: Next.js dashboard
```
