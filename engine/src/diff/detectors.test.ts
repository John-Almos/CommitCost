import { describe, expect, it } from "vitest";
import { analyzeFile, instanceUnits, scheduleIntervalMinutes } from "./detectors.js";
import { parsePatch } from "./parse.js";

const run = (path: string, patch: string) => analyzeFile({ path, patch });
const detectors = (path: string, patch: string) => run(path, patch).map((f) => f.detector);

describe("parsePatch", () => {
  it("tracks old and new line numbers", () => {
    const [h] = parsePatch("@@ -10,3 +10,3 @@ fn()\n a\n-b\n+c\n d");
    expect(h!.header).toBe("fn()");
    expect(h!.lines).toEqual([
      { kind: "ctx", text: "a", oldLine: 10, newLine: 10 },
      { kind: "del", text: "b", oldLine: 11 },
      { kind: "add", text: "c", newLine: 11 },
      { kind: "ctx", text: "d", oldLine: 12, newLine: 12 },
    ]);
  });
});

describe("query-in-loop", () => {
  it("flags a SQL query added inside a for loop, at the query line", () => {
    const findings = run(
      "src/routes/orders.ts",
      `@@ -1,3 +1,8 @@
 const orders = await db.query("SELECT * FROM orders");
+for (const order of orders.rows) {
+  const items = await db.query(
+    "SELECT * FROM order_items WHERE order_id = $1",
+    [order.id],
+  );
+}`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ detector: "query-in-loop", services: ["RDS"], line: 3, direction: "increase" });
    expect(findings[0]!.suggestion).toMatch(/one query/);
  });

  it("flags DynamoDB calls inside .map and Python ORM calls inside for-in", () => {
    expect(
      run("a.ts", `@@ -1 +1,4 @@\n+await Promise.all(ids.map(async (id) => {\n+  await ddb.send(new GetItemCommand({ Key: { id } }));\n+}));`)[0],
    ).toMatchObject({ services: ["DynamoDB"] });
    expect(run("views.py", `@@ -1 +1,3 @@\n+for user in users:\n+    orders = Order.objects.filter(user=user)\n+    total += len(orders)`)[0]).toMatchObject({
      services: ["RDS"],
    });
  });

  it("ignores queries outside loops, loops without queries, and untouched loops", () => {
    expect(detectors("a.ts", `@@ -1 +1,2 @@\n+const rows = await db.query("SELECT 1");\n+return rows;`)).toEqual([]);
    expect(detectors("a.ts", `@@ -1 +1,3 @@\n+for (const x of xs) {\n+  total += x.price;\n+}`)).toEqual([]);
    expect(detectors("a.ts", `@@ -1,3 +1,3 @@\n for (const o of orders) {\n   await db.query("SELECT 1");\n-  log(o);\n+  log(o.id);\n }`)).toEqual([]);
  });

  it("does not treat Array.find as a database call", () => {
    expect(detectors("a.ts", `@@ -1 +1,3 @@\n+for (const o of orders) {\n+  const match = items.find((i) => i.id === o.id);\n+}`)).toEqual([]);
  });
});

describe("removed-cache", () => {
  it("flags a removed cache in front of DynamoDB", () => {
    const [f] = run(
      "catalog.ts",
      `@@ -1,6 +1,3 @@
-  const cached = await this.cache.get(key);
-  if (cached) return JSON.parse(cached);
   const res = await this.ddb.send(new GetItemCommand(params));
-  await this.cache.set(key, JSON.stringify(res), { EX: 600 });
   return res;`,
    );
    expect(f).toMatchObject({ detector: "removed-cache", services: ["DynamoDB"], side: "old", line: 1 });
  });

  it("ignores a cache refactor that keeps caching", () => {
    expect(detectors("c.ts", `@@ -1,2 +1,2 @@\n-  const v = await cache.get(key);\n+  const v = await cache.get(namespaced(key));`)).toEqual([]);
  });
});

describe("removed-batching", () => {
  it("flags a removed LIMIT", () => {
    expect(run("r.ts", `@@ -1 +1 @@\n-  await db.query("SELECT * FROM events ORDER BY ts LIMIT 100");\n+  await db.query("SELECT * FROM events ORDER BY ts");`)[0]).toMatchObject({
      detector: "removed-batching",
      services: ["RDS"],
    });
  });

  it("ignores a changed page size", () => {
    expect(detectors("r.ts", `@@ -1 +1 @@\n-  const pageSize = 50;\n+  const pageSize = 100;`)).toEqual([]);
  });
});

describe("compute-size", () => {
  it("computes the size ratio of instance types", () => {
    expect(instanceUnits("m5.xlarge")).toBe(4);
    expect(instanceUnits("m5.2xlarge")).toBe(8);
    expect(instanceUnits("db.r6g.large")).toBe(2);
    expect(instanceUnits("t3.micro")).toBe(0.25);
    expect(instanceUnits("not-an-instance")).toBeNull();
  });

  it("flags EC2 and RDS upsizes and downsizes", () => {
    expect(run("infra/worker.tf", `@@ -1 +1 @@\n-  instance_type = "m5.xlarge"\n+  instance_type = "m5.4xlarge"`)[0]).toMatchObject({
      services: ["EC2"],
      direction: "increase",
      costRatio: 4,
    });
    expect(run("infra/db.tf", `@@ -1 +1 @@\n-  instance_class = "db.r6g.2xlarge"\n+  instance_class = "db.r6g.xlarge"`)[0]).toMatchObject({
      services: ["RDS"],
      direction: "decrease",
    });
    expect(run("stack.ts", `@@ -1 +1 @@\n-  instanceType: "c5.large",\n+  instanceType: "c5.xlarge",`)[0]).toMatchObject({ services: ["EC2"] });
  });

  it("ignores an AMI change", () => {
    expect(detectors("web.tf", `@@ -1 +1 @@\n-  ami_id = "ami-1"\n+  ami_id = "ami-2"`)).toEqual([]);
  });
});

describe("capacity and Lambda config", () => {
  it("flags Lambda memory with a cost ratio, and timeout with low confidence", () => {
    const findings = run("serverless.yml", `@@ -1,2 +1,2 @@\n-    memorySize: 512\n-    timeout: 30\n+    memorySize: 2048\n+    timeout: 300`);
    expect(findings.map((f) => [f.detector, f.costRatio, f.confidence])).toEqual([
      ["lambda-config", 4, 0.9],
      ["lambda-config", undefined, 0.35],
    ]);
  });

  it("flags provisioned concurrency and Terraform memory_size", () => {
    expect(run("lambda.tf", `@@ -1 +1 @@\n-  memory_size = 128\n+  memory_size = 1024`)[0]).toMatchObject({ services: ["Lambda"], costRatio: 8 });
    expect(run("fn.tf", `@@ -1 +1 @@\n-  provisioned_concurrent_executions = 1\n+  provisioned_concurrent_executions = 10`)[0]).toMatchObject({ confidence: 0.85 });
  });

  it("flags replica counts and DynamoDB capacity", () => {
    expect(run("asg.tf", `@@ -1 +1 @@\n-  desired_capacity = 2\n+  desired_capacity = 6`)[0]).toMatchObject({ detector: "capacity-increase", services: ["EC2"], costRatio: 3 });
    expect(run("k8s/deploy.yaml", `@@ -1 +1 @@\n-  replicas: 3\n+  replicas: 9`)[0]).toMatchObject({ services: ["EC2"] });
    expect(run("dynamodb.tf", `@@ -1 +1 @@\n-  read_capacity = 5\n+  read_capacity = 50`)[0]).toMatchObject({ services: ["DynamoDB"], costRatio: 10 });
  });

  it("ignores capacity-like keys in application code and plain timeouts", () => {
    expect(detectors("src/pool.ts", `@@ -1 +1 @@\n-  const replicas = 2;\n+  const replicas = 4;`)).toEqual([]);
    expect(detectors("src/http.ts", `@@ -1 +1 @@\n-  timeout: 1000,\n+  timeout: 5000,`)).toEqual([]);
  });
});

describe("schedule-frequency", () => {
  it("parses rate and cron expressions", () => {
    expect(scheduleIntervalMinutes("rate(5 minutes)")).toBe(5);
    expect(scheduleIntervalMinutes("rate(1 hour)")).toBe(60);
    expect(scheduleIntervalMinutes("cron(0 2 * * ? *)")).toBe(1440);
    expect(scheduleIntervalMinutes(`schedule: "*/10 * * * *"`)).toBe(10);
    expect(scheduleIntervalMinutes("cron(0 */2 * * ? *)")).toBe(120);
  });

  it("flags a schedule that runs more often", () => {
    const [f] = run("serverless.yml", `@@ -1 +1 @@\n-      - schedule: rate(1 hour)\n+      - schedule: rate(1 minute)`);
    expect(f).toMatchObject({ detector: "schedule-frequency", services: ["Lambda"], costRatio: 60, confidence: 0.75 });
  });

  it("flags a new schedule with low confidence, and ignores a slower one", () => {
    expect(run("jobs.tf", `@@ -1 +1,2 @@\n+  schedule_expression = "rate(5 minutes)"`)[0]).toMatchObject({ confidence: 0.4 });
    expect(detectors("serverless.yml", `@@ -1 +1 @@\n-      - schedule: rate(5 minutes)\n+      - schedule: rate(1 hour)`)).toEqual([]);
  });
});

describe("cross-region-transfer and S3 lifecycle", () => {
  it("flags S3 replication and NAT gateways in IaC", () => {
    expect(run("s3.tf", `@@ -1 +1,2 @@\n+resource "aws_s3_bucket_replication_configuration" "x" {\n+}`)[0]).toMatchObject({ services: ["S3", "DataTransfer"] });
    expect(run("vpc.tf", `@@ -1 +1 @@\n+resource "aws_nat_gateway" "main" {`)[0]).toMatchObject({ services: ["DataTransfer", "EC2"] });
  });

  it("ignores replication words in application code", () => {
    expect(detectors("src/replica.ts", `@@ -1 +1 @@\n+const replication_configuration = load();`)).toEqual([]);
  });

  it("flags a removed lifecycle rule", () => {
    const patch = `@@ -1,8 +1,0 @@\n-resource "aws_s3_bucket_lifecycle_configuration" "logs" {\n-  rule {\n-    expiration {\n-      days = 30\n-    }\n-  }\n-}`;
    expect(run("s3.tf", patch)[0]).toMatchObject({ detector: "s3-lifecycle-removed", services: ["S3"] });
  });
});

describe("hot-path-logging", () => {
  it("flags logging added inside a loop", () => {
    expect(run("worker.ts", `@@ -1 +1,4 @@\n for (const msg of batch) {\n+  logger.info({ msg }, "processing");\n   await handle(msg);\n }`)[0]).toMatchObject({
      detector: "hot-path-logging",
      costArea: "CloudWatch Logs ingestion",
      line: 2,
    });
  });

  it("flags debug log level in config but not in tests", () => {
    expect(detectors("config/prod.ts", `@@ -1 +1 @@\n-  level: "info",\n+  level: "debug",`)).toEqual(["hot-path-logging"]);
    expect(detectors("test/setup.ts", `@@ -1 +1 @@\n+  level: "debug",`)).toEqual([]);
  });

  it("ignores logging outside loops", () => {
    expect(detectors("a.ts", `@@ -1 +1 @@\n+logger.info("started");`)).toEqual([]);
  });
});
