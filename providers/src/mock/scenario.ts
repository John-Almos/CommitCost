import type { DeployFile, Service } from "@commitcost/core";

/**
 * The cost-changing commits injected into the mock history. Each one has a
 * realistic diff and a known effect on one service, so the attribution engine
 * can be tested against ground truth: the commit below should rank #1 for the
 * anomaly it causes.
 */
export type InjectedKind =
  | "n-plus-one-query"
  | "lambda-memory-increase"
  | "cross-region-replication"
  | "instance-resize"
  | "removed-cache"
  | "right-size-revert";

export interface CostEffect {
  service: Service;
  /** `app` tag value the extra spend lands on. */
  tagValue: string;
  /** Change in daily cost once fully ramped, before weekly seasonality. */
  dailyDeltaUsd: number;
  /** Days to reach the full delta (0 = immediate step). */
  rampDays: number;
  /** Whether the delta follows the service's weekday/weekend pattern. */
  followsTraffic: boolean;
  /** Usage type the extra spend is billed under, as Cost Explorer reports it. */
  usageType: string;
  /** Once in force, the tag's existing spend on this usage type moves to `usageType` (an in-place resize). */
  replacesUsageType?: string;
}

export interface InjectedChange {
  key: string;
  kind: InjectedKind;
  /** Day index (from the start of the window) the cost first moves. */
  onsetDay: number;
  /** Days between merge and cost onset. */
  lagDays: number;
  /** UTC hour of the merge. */
  mergeHourUtc: number;
  title: string;
  body: string;
  author: string;
  files: DeployFile[];
  effects: CostEffect[];
  /** Plain-English cause, used as the expected explanation in the demo. */
  why: string;
}

/**
 * A deploy that looks plausible as a cause (right timing, related files) but
 * didn't change cost. Placed in the lookback window of an injected change so
 * ranking has to rely on the diff, not just "the only commit nearby".
 */
export interface Decoy {
  /** Key of the injected change this sits next to. */
  near: string;
  /** Days before the injected change's merge. */
  daysBefore: number;
  title: string;
  author: string;
  files: DeployFile[];
}

/** A cost blip with no code cause (traffic burst, bot crawl). */
export interface UnexplainedEvent {
  key: string;
  day: number;
  service: Service;
  tagValue: string;
  deltaUsd: number;
  usageType: string;
  why: string;
}

function file(path: string, patch: string): DeployFile {
  const lines = patch.split("\n");
  return {
    path,
    additions: lines.filter((l) => l.startsWith("+")).length,
    deletions: lines.filter((l) => l.startsWith("-")).length,
    patch,
  };
}

export const INJECTED_CHANGES: InjectedChange[] = [
  {
    key: "orders-n-plus-one",
    kind: "n-plus-one-query",
    onsetDay: 20,
    lagDays: 2,
    mergeHourUtc: 17,
    title: "Show line items on order history page",
    body: "Customers asked to see what was in each past order without clicking through.",
    author: "dev-priya",
    files: [
      file(
        "services/api/src/routes/orders.ts",
        `@@ -38,9 +38,17 @@ router.get("/orders/history", async (req, res) => {
   const orders = await db.query(
     "SELECT id, created_at, total_cents, status FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50",
     [req.user.id],
   );
-  res.json({ orders: orders.rows });
+  const result = [];
+  for (const order of orders.rows) {
+    const items = await db.query(
+      "SELECT sku, name, quantity, price_cents FROM order_items WHERE order_id = $1",
+      [order.id],
+    );
+    result.push({ ...order, items: items.rows });
+  }
+  res.json({ orders: result });
 });`,
      ),
      file(
        "web/src/pages/orders/history.tsx",
        `@@ -21,6 +21,13 @@ export function OrderHistory({ orders }: Props) {
         <td>{formatDate(order.created_at)}</td>
         <td>{formatMoney(order.total_cents)}</td>
         <td><StatusPill status={order.status} /></td>
+        <td>
+          <ul className="line-items">
+            {order.items.map((item) => (
+              <li key={item.sku}>{item.quantity} × {item.name}</li>
+            ))}
+          </ul>
+        </td>
       </tr>`,
      ),
    ],
    effects: [{ service: "RDS", tagValue: "api", dailyDeltaUsd: 95, rampDays: 1, followsTraffic: false, usageType: "Multi-AZUsage:db.r6g.xl" }],
    why: "Adds a query per order inside a loop (N+1) on a hot endpoint, so RDS read IOPS and instance load jump once the web release picks it up.",
  },
  {
    key: "reports-lambda-memory",
    kind: "lambda-memory-increase",
    onsetDay: 33,
    lagDays: 0,
    mergeHourUtc: 9,
    title: "Fix report generation timeouts for large accounts",
    body: "Large accounts were hitting the 30s timeout. Giving the function more headroom.",
    author: "jkowalski",
    files: [
      file(
        "services/worker/serverless.yml",
        `@@ -44,8 +44,8 @@ functions:
   generateReports:
     handler: src/handlers/generateReports.handler
-    memorySize: 512
-    timeout: 30
+    memorySize: 3008
+    timeout: 300
     events:
       - sqs:
           arn: !GetAtt ReportQueue.Arn`,
      ),
    ],
    effects: [{ service: "Lambda", tagValue: "worker", dailyDeltaUsd: 115, rampDays: 0, followsTraffic: true, usageType: "Lambda-GB-Second" }],
    why: "Raises Lambda memory from 512 MB to 3008 MB (5.9x the GB-second price) and the timeout 10x on a function that runs on every queued report.",
  },
  {
    key: "uploads-replication",
    kind: "cross-region-replication",
    onsetDay: 45,
    lagDays: 1,
    mergeHourUtc: 15,
    title: "Replicate uploads bucket to us-west-2 for DR",
    body: "Part of the disaster recovery plan. Replicates all new objects to a second region.",
    author: "tnguyen",
    files: [
      file(
        "infra/terraform/s3.tf",
        `@@ -61,3 +61,31 @@ resource "aws_s3_bucket_versioning" "uploads" {
     status = "Enabled"
   }
 }
+
+resource "aws_s3_bucket" "uploads_replica" {
+  provider = aws.us_west_2
+  bucket   = "acme-uploads-replica"
+}
+
+resource "aws_s3_bucket_replication_configuration" "uploads" {
+  role   = aws_iam_role.replication.arn
+  bucket = aws_s3_bucket.uploads.id
+
+  rule {
+    id     = "replicate-all"
+    status = "Enabled"
+
+    filter {}
+
+    destination {
+      bucket        = aws_s3_bucket.uploads_replica.arn
+      storage_class = "STANDARD"
+    }
+
+    delete_marker_replication {
+      status = "Enabled"
+    }
+  }
+}`,
      ),
    ],
    effects: [
      { service: "DataTransfer", tagValue: "", dailyDeltaUsd: 62, rampDays: 3, followsTraffic: true, usageType: "USE1-USW2-AWS-Out-Bytes" },
      { service: "S3", tagValue: "", dailyDeltaUsd: 14, rampDays: 3, followsTraffic: false, usageType: "USW2-TimedStorage-ByteHrs" },
    ],
    why: "Turns on cross-region replication for every object in the uploads bucket, adding inter-region transfer charges plus a second copy of storage in STANDARD class.",
  },
  {
    key: "reports-right-size",
    kind: "right-size-revert",
    onsetDay: 47,
    lagDays: 0,
    mergeHourUtc: 10,
    title: "Right-size generateReports memory after profiling",
    body: "Profiling showed peak usage around 800 MB. 1024 MB keeps the timeout fix without the cost.",
    author: "jkowalski",
    files: [
      file(
        "services/worker/serverless.yml",
        `@@ -44,8 +44,8 @@ functions:
   generateReports:
     handler: src/handlers/generateReports.handler
-    memorySize: 3008
-    timeout: 300
+    memorySize: 1024
+    timeout: 120
     events:
       - sqs:
           arn: !GetAtt ReportQueue.Arn`,
      ),
    ],
    effects: [{ service: "Lambda", tagValue: "worker", dailyDeltaUsd: -91, rampDays: 0, followsTraffic: true, usageType: "Lambda-GB-Second" }],
    why: "Lowers Lambda memory from 3008 MB to 1024 MB, removing most of the earlier increase.",
  },
  {
    key: "worker-instance-resize",
    kind: "instance-resize",
    onsetDay: 58,
    lagDays: 1,
    mergeHourUtc: 19,
    title: "Speed up nightly export by upsizing worker instances",
    body: "The nightly export was running into business hours. Doubling the worker instance size.",
    author: "sam-oyelaran",
    files: [
      file(
        "infra/terraform/worker.tf",
        `@@ -12,10 +12,10 @@ module "worker_asg" {
   source = "./modules/asg"

   name             = "worker"
-  instance_type    = "m5.xlarge"
+  instance_type    = "m5.2xlarge"
   min_size         = 24
   max_size         = 48
   desired_capacity = 32`,
      ),
    ],
    effects: [{ service: "EC2", tagValue: "worker", dailyDeltaUsd: 150, rampDays: 0, followsTraffic: false, usageType: "BoxUsage:m5.2xlarge", replacesUsageType: "BoxUsage:m5.xlarge" }],
    why: "Changes the worker Auto Scaling group from m5.xlarge to m5.2xlarge, doubling the hourly price of every worker instance around the clock for a job that runs once a night.",
  },
  {
    key: "product-cache-removed",
    kind: "removed-cache",
    onsetDay: 71,
    lagDays: 1,
    mergeHourUtc: 16,
    title: "Remove Redis cache from product lookups (stale price bug)",
    body: "Cached prices were up to 10 minutes stale after edits. Reading straight from DynamoDB instead.",
    author: "alice-chen",
    files: [
      file(
        "services/api/src/services/productCatalog.ts",
        `@@ -14,20 +14,11 @@ export class ProductCatalog {
   async getProduct(id: string): Promise<Product | null> {
-    const cached = await this.cache.get(\`product:\${id}\`);
-    if (cached) return JSON.parse(cached);
-
     const res = await this.ddb.send(
       new GetItemCommand({ TableName: PRODUCTS_TABLE, Key: { pk: { S: id } } }),
     );
-    const product = res.Item ? unmarshall(res.Item) as Product : null;
-    if (product) {
-      await this.cache.set(\`product:\${id}\`, JSON.stringify(product), { EX: 600 });
-    }
-    return product;
+    return res.Item ? (unmarshall(res.Item) as Product) : null;
   }`,
      ),
    ],
    effects: [{ service: "DynamoDB", tagValue: "api", dailyDeltaUsd: 55, rampDays: 0, followsTraffic: true, usageType: "ReadRequestUnits" }],
    why: "Removes the Redis read-through cache in front of DynamoDB product lookups, so every page view becomes a DynamoDB read.",
  },
];

export const DECOYS: Decoy[] = [
  {
    near: "orders-n-plus-one",
    daysBefore: 1,
    title: "Refactor order repository to use a query builder",
    author: "bmartinez",
    files: [
      file(
        "services/api/src/db/orderRepository.ts",
        `@@ -8,12 +8,10 @@ export async function findOrder(id: string) {
-  const res = await db.query(
-    "SELECT id, customer_id, total_cents, status, created_at FROM orders WHERE id = $1",
-    [id],
-  );
-  return res.rows[0] ?? null;
+  return qb("orders")
+    .select("id", "customer_id", "total_cents", "status", "created_at")
+    .where({ id })
+    .first();
 }`,
      ),
    ],
  },
  {
    near: "reports-lambda-memory",
    daysBefore: 1,
    title: "Bump worker Lambda runtime to nodejs22.x",
    author: "tnguyen",
    files: [
      file(
        "services/worker/serverless.yml",
        `@@ -6,7 +6,7 @@ provider:
   name: aws
-  runtime: nodejs20.x
+  runtime: nodejs22.x
   region: us-east-1`,
      ),
    ],
  },
  {
    near: "uploads-replication",
    daysBefore: 0,
    title: "Add cost-allocation tags to S3 buckets",
    author: "sam-oyelaran",
    files: [
      file(
        "infra/terraform/s3.tf",
        `@@ -3,6 +3,10 @@ resource "aws_s3_bucket" "uploads" {
   bucket = "acme-uploads"
+  tags = {
+    app   = "api"
+    owner = "platform"
+  }
 }`,
      ),
    ],
  },
  {
    near: "worker-instance-resize",
    daysBefore: 1,
    title: "Update AMI for web tier to latest Amazon Linux 2023",
    author: "bmartinez",
    files: [
      file(
        "infra/terraform/web.tf",
        `@@ -20,7 +20,7 @@ module "web_asg" {
   name          = "web"
-  ami_id        = "ami-0a1b2c3d4e5f60001"
+  ami_id        = "ami-0a1b2c3d4e5f60417"
   instance_type = "t3.large"`,
      ),
    ],
  },
  {
    near: "product-cache-removed",
    daysBefore: 1,
    title: "Add DynamoDB table for feature flags",
    author: "dev-priya",
    files: [
      file(
        "infra/terraform/dynamodb.tf",
        `@@ -40,3 +40,15 @@ resource "aws_dynamodb_table" "products" {
 }
+
+resource "aws_dynamodb_table" "feature_flags" {
+  name         = "feature-flags"
+  billing_mode = "PAY_PER_REQUEST"
+  hash_key     = "flag"
+
+  attribute {
+    name = "flag"
+    type = "S"
+  }
+}`,
      ),
    ],
  },
];

export const UNEXPLAINED_EVENTS: UnexplainedEvent[] = [
  {
    key: "crawler-burst",
    day: 63,
    service: "DataTransfer",
    tagValue: "web",
    deltaUsd: 85,
    usageType: "DataTransfer-Out-Bytes",
    why: "A one-day crawler burst on the marketing site. No code change caused it.",
  },
];
