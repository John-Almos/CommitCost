# Running CommitCost for other companies

Hosted mode lets any company sign in, create a workspace, and connect its own AWS account and GitHub repos. This page is for whoever operates the CommitCost server.

## How a company connects

1. **Sign in with GitHub.** CommitCost reads only the user's GitHub profile. A new user creates a workspace; teammates are invited by GitHub username and join when they sign in.
2. **Connect AWS.** On Settings → AWS, an owner launches a CloudFormation stack (one click when the template is hosted in S3, otherwise download and upload it). The stack creates one IAM role:
   - trusted only by CommitCost's AWS principal (`COMMITCOST_AWS_PRINCIPAL_ARN`),
   - only when the caller passes the workspace's external ID (`sts:ExternalId`), which stops one customer pointing CommitCost at another customer's role,
   - allowed only `ce:GetCostAndUsage` and `ce:GetTags`.

   The owner pastes the role ARN back. Before saving, CommitCost assumes the role with the external ID, checks that it **cannot** be assumed without it, and makes one small Cost Explorer request (about $0.01). Nothing secret is stored: only the role ARN.
3. **Connect GitHub.** The owner installs the CommitCost GitHub App on the repos they choose, then ticks which to track. CommitCost confirms through OAuth that the signed-in user can access the installation before linking it, since the installation ID arrives in a URL anyone could edit. Installation tokens are minted per sync and expire within an hour.
4. **Sync.** Connecting queues the first sync (90 days). The worker re-syncs every workspace every `COMMITCOST_SYNC_INTERVAL_HOURS` hours, and members can click Sync now. Each run's log is on Settings → Overview.

## One-time operator setup

### 1. Register the GitHub App

On GitHub: Settings → Developer settings → GitHub Apps → New GitHub App (under the organization that will own CommitCost).

| Setting | Value |
| --- | --- |
| Homepage URL | `COMMITCOST_URL` |
| Callback URL | `${COMMITCOST_URL}/auth/github/callback` |
| Request user authorization (OAuth) during installation | **Off** (CommitCost does its own OAuth step after install) |
| Setup URL | `${COMMITCOST_URL}/github/setup`, with **Redirect on update** on |
| Webhook URL | `${COMMITCOST_URL}/api/github/webhook`, with a random secret |
| Repository permissions | Contents: Read-only, Pull requests: Read-only, Metadata: Read-only |
| Account permissions | none |
| Subscribe to events | Installation target and installation events are sent automatically; nothing else is needed |
| Where can this app be installed | Any account |

Then generate a private key and note the App ID, slug (from the app's public URL), client ID and a new client secret. Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY_PATH` (or `GITHUB_APP_PRIVATE_KEY`) and `GITHUB_APP_WEBHOOK_SECRET`. Setting these switches sign-in on.

### 2. Give CommitCost an AWS identity

Customer roles trust one principal: the IAM role your CommitCost server and worker run as. Create it in your own AWS account with a single permission, `sts:AssumeRole` on `arn:aws:iam::*:role/CommitCostReadOnly` (or `*` if customers may rename the role), run the server and worker with it (an instance role, ECS task role or similar; the standard AWS credential chain is used), and set `COMMITCOST_AWS_PRINCIPAL_ARN` to its ARN.

### 3. Host the CloudFormation template (for one-click Launch stack)

CloudFormation's quick-create link only accepts templates in S3.

```sh
COMMITCOST_AWS_PRINCIPAL_ARN=arn:aws:iam::123456789012:role/commitcost \
  npm run --silent cli -- cfn-template > commitcost-aws-role.json
aws s3 cp commitcost-aws-role.json s3://YOUR-BUCKET/commitcost-aws-role.json
```

Make the object publicly readable and set `COMMITCOST_CFN_TEMPLATE_URL` to its HTTPS URL. Without it, customers download the template from the AWS settings page instead.

### 4. Database, web app and worker

- Use Postgres in production: `npm run db:schema:postgres`, set `DATABASE_URL`, and apply `db/prisma/postgres/schema.prisma` with `prisma db push` (or migrations).
- Set `COMMITCOST_URL` (public HTTPS URL) and `COMMITCOST_SECRET` (32+ random characters).
- Run the web app: `npm run build:web && npm run start -w @commitcost/web`.
- Run at least one worker: `npm run worker`. Several workers are safe; each job is claimed by exactly one. `npm run worker -- --once` drains the queue and exits, which suits a cron job.
- Optional: `npm run seed` creates the Demo workspace that every signed-in user can browse.
- Optional: `npm run cli -- sync-org --org <slug>` runs one workspace's sync immediately, for support.

## Security notes

- No customer secrets are stored. AWS access is a role ARN plus a per-workspace external ID; GitHub access is an installation ID, with tokens minted from the App key per sync.
- Session cookies are random 256-bit tokens; only their SHA-256 is stored. OAuth state is HMAC-signed, expires after 10 minutes, and is bound to the browser with a nonce cookie.
- Every query is scoped by the workspace taken from the session. Server actions re-check membership and role (owners manage connections and people; members can view and start a sync).
- Webhooks are verified with `X-Hub-Signature-256`. Uninstalling the App removes its installation and tracked repos; synced history stays until the workspace is deleted.
- Without a GitHub App configured, the app refuses to start in production unless `COMMITCOST_ALLOW_LOCAL_MODE=1`, because local mode signs everyone in as one user.

## Not built yet

- Billing and plans, SSO/SAML, and audit logs.
- GCP and Azure (a new `CostProvider` each).
- A per-workspace pricing/usage profile is reserved (`Organization.pricingProfile`) for the cost-estimation module.
