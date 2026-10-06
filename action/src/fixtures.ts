/** Sample PR diffs used by tests and the dashboard's PR check page. */
export const SAMPLE_PRS = {
  nPlusOne: {
    title: "Show line items on the order history page",
    files: [
      {
        filename: "services/api/src/routes/orders.ts",
        status: "modified",
        patch: `@@ -38,9 +38,17 @@ router.get("/orders/history", async (req, res) => {
   const orders = await db.query(
     "SELECT id, created_at, total_cents FROM orders WHERE customer_id = $1 LIMIT 50",
     [req.user.id],
   );
-  res.json({ orders: orders.rows });
+  const result = [];
+  for (const order of orders.rows) {
+    const items = await db.query(
+      "SELECT sku, name, quantity FROM order_items WHERE order_id = $1",
+      [order.id],
+    );
+    result.push({ ...order, items: items.rows });
+  }
+  res.json({ orders: result });
 });`,
      },
      {
        filename: "services/api/src/routes/orders.test.ts",
        status: "modified",
        patch: `@@ -1 +1,4 @@\n+for (const id of ids) {\n+  await db.query("DELETE FROM orders WHERE id = $1", [id]);\n+}`,
      },
    ],
  },
  infra: {
    title: "Scale workers and speed up report Lambda",
    files: [
      {
        filename: "infra/terraform/worker.tf",
        status: "modified",
        patch: `@@ -12,10 +12,10 @@ module "worker_asg" {
   source = "./modules/asg"
 
   name             = "worker"
-  instance_type    = "m5.xlarge"
+  instance_type    = "m5.2xlarge"
   min_size         = 3
   max_size         = 6
   desired_capacity = 3`,
      },
      {
        filename: "services/worker/serverless.yml",
        status: "modified",
        patch: `@@ -44,8 +44,8 @@ functions:
   generateReports:
     handler: src/handlers/generateReports.handler
-    memorySize: 512
-    timeout: 30
+    memorySize: 3008
+    timeout: 300
     events:
       - schedule: rate(1 hour)`,
      },
    ],
  },
  clean: {
    title: "Fix button alignment",
    files: [{ filename: "web/src/components/Button.tsx", status: "modified", patch: `@@ -10,1 +10,1 @@\n-  <div className="btn mt-2">\n+  <div className="btn mt-2 items-center">` }],
  },
} as const;
