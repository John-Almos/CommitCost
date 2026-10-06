# Cost model

CommitCost computes cost in two separate ways.

- **Measured** comes from the bill. Cost Explorer gives daily cost per service and tag. An anomaly's size is the observed daily cost minus a weekday-aware 14-day median, and a persistent change's monthly impact is that daily change × 30 (`engine/src/anomaly.ts`). This is what the overview and anomaly pages show.
- **Modeled** is calculated from a diff before anything is billed. This is what the PR check shows, and what the anomaly page compares with the measured figure. It lives in `engine/src/cost/` and is described below.

## The calculation

Every modeled estimate is `quantity × unit price × effective rate`, built from three layers:

1. **Unit prices** (`PriceBook`). These are AWS on-demand list prices keyed by region, price-list offer (`AmazonEC2`, `AWSLambda`, ...) and usage type (`BoxUsage:m5.xlarge`, `Lambda-GB-Second`, `USW2-AWS-Out-Bytes`). Volume tiers are kept. There are two sources:
   - A bundled snapshot, `engine/src/cost/aws/snapshot.json`, covering 7 regions. `npm run prices:snapshot` builds it from AWS's public Price List bulk files, which need no credentials. Mock mode, tests and the GitHub Action use it.
   - Live prices from the Price List API (`pricing:GetProducts`) when `COMMITCOST_PRICING=live`. `sync` loads the regions your usage is in, caches them for a week, and saves them to `.commitcost/prices.json`, which the dashboard and `profile` then use.

   Both sources go through the same filters (`engine/src/cost/aws/offers.ts`): Linux shared-tenancy EC2, RDS engines by operation code, Lambda, DynamoDB, S3 storage classes and requests, data transfer (cross-AZ, internet egress, inter-region to every region), NAT gateways, EBS and CloudWatch Logs.

2. **Usage** (`UsageProfile`). Cost Explorer grouped by `USAGE_TYPE` and the cost-allocation tag, with the `UsageQuantity` and cost metrics, gives each usage type's volume and cost per day. `buildUsageProfile` scales the last 14 days to a 730-hour month and computes:
   - the volume per usage type and tag: instance hours, GB on each network path, GB-seconds, request units;
   - the **effective rate**: cost ÷ quantity, compared with the tiered list price. A ratio of 0.85 means you pay 15% below list, for example from a Savings Plan.

3. **Estimators** (`estimate.ts`). There is one per diff detector. Each reads what the diff states (instance types, counts, memory, capacity, region, engine, storage class, schedule), looks up prices for the resource's region, and pulls volumes from the usage profile when the diff can't give them. For example:

   | Change | Formula |
   | --- | --- |
   | Instance resize | instances × (new − old hourly price) × 730 h × effective rate. The instance count is the bill's average under the resource's tag when it can be matched, else the diff's `desired_capacity`/`count`/`min_size`. |
   | Instance count | added instances × hourly price × 730 h × effective rate |
   | Lambda memory | tagged GB-seconds × (new/old − 1) × GB-second price. This is an upper bound: it assumes the tag's Lambda usage is all this function. With `lambdaInvocationsPerMonth`, the figure is exact. |
   | Provisioned concurrency | added units × memory GB × price × 2,628,000 s |
   | DynamoDB capacity | added RCU/WCU × unit-hour price × 730 h |
   | N+1 query (DynamoDB/S3) | requests × items (from the outer query's `LIMIT`) × read or GET price. This is per million requests unless `requestsPerMonth` is set. |
   | N+1 query (RDS) | the cost of the next instance size up for the tag's current fleet. RDS doesn't bill per query, so this is what the extra load costs if it forces an upsize. |
   | Removed cache | tagged reads × hit ÷ (1 − hit) × read price |
   | S3 replication | GB written × inter-region price + GB × replica storage price (this repeats every month) + PUTs × request price. GB written comes from S3 data-in usage or `replicatedGbPerMonth`. |
   | NAT gateway | gateways × hourly price × 730 h, + price per GB processed |
   | Log retention, debug logging, logging in loops | ingested GB × storage or ingestion price |

Every estimate returns a `CostEstimate`: the headline figure (or a range, or a per-unit price), the formula as text, each input with its value, unit and **source** (`diff`, `usage`, `price-list`, `config`, `default`) plus a reference such as the price key and date, and its assumptions. When the bill disagrees with the diff (the diff sets 24 instances but the bill shows 38 running), the estimate uses the bill and keeps the diff-only figure in `calibration`.

**Basis** says how much an estimate rests on data:

- `usage-calibrated`: the volumes come from your bill.
- `list-price`: diff values × list prices.
- `per-unit`: a price per unit of traffic, because the volume isn't known.
- `qualitative`: the direction is known but not the size.

## Assumptions

Anything neither the diff nor the bill gives is a named assumption (`DEFAULT_ASSUMPTIONS` in `context.ts`): items per loop, cache hit rate, default instance count and type, RDS engine, scheduled run length, log line size, and optional traffic volumes. Estimates show which ones they used, marked as defaults, and they can be overridden with the Action's `assumptions` input. The dashboard's Cost model page lists them all.

## Getting your usage into PR checks

The Action runs in CI without cloud credentials. `npm run profile` writes `.commitcost/cost-profile.json` from synced usage: monthly volumes, effective and list rates per usage type and tag, and the main region. The file has no credentials in it. Pass it as `cost-profile`, and estimates are calibrated as they are on the dashboard.

## How well it fits

`npm run demo` prints a cost model check, and `engine/src/cost/cost.test.ts` asserts it. Each injected change in the mock scenario is priced from its diff and the two weeks of usage before it merged, then compared with what the bill measured after:

| Change | Measured | Modeled |
| --- | --- | --- |
| N+1 on order history (RDS) | +$2,850/mo | up to +$3,322/mo |
| Lambda 512 → 3008 MB | +$3,450/mo | up to +$3,049/mo |
| S3 replication to us-west-2 | +$2,280/mo | up to +$4,124/mo (includes a full month of replica storage) |
| Lambda right-size 3008 → 1024 MB | −$2,730/mo | −$2,543/mo |
| Worker m5.xlarge → m5.2xlarge | +$4,500/mo | +$4,584/mo |
| Redis cache removed (DynamoDB) | +$1,650/mo | up to +$2,147/mo |

The mock bill's usage is derived from the same price snapshot, so this checks that the model is consistent, not that it is accurate on a real account. The Cost model page shows the same comparison for real data once an account is synced.

## Adding GCP or Azure

The interfaces in `core/src/pricing.ts` are cloud-neutral:

- `PriceBook.price(region, service, meter)` returns a `UnitPrice` with tiers. A GCP book would key by Cloud Billing Catalog service and SKU, and an Azure book by Retail Prices API `meterId`.
- `UsageProvider.getUsage(range)` returns `UsageRecord`s. These would come from the GCP BigQuery billing export (`sku.id`, `usage.amount`, `cost`) and from Azure Cost Management usage details (`meterId`, `quantity`, `costInBillingCurrency`).
- The estimators need a mapping from each detector's resource (instance type, function memory, network path) to that cloud's meters, in the same way as `aws/usageTypes.ts` and `aws/offers.ts` for AWS.
