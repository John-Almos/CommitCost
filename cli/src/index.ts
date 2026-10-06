#!/usr/bin/env tsx
import { createClient } from "@commitcost/db";
import { runDemo } from "./demo.js";
import { seedMock } from "./seed.js";

const USAGE = `Usage: commitcost <command>

Commands:
  seed    Generate mock AWS costs and GitHub history and store them locally
  demo    Seed mock data and print a summary of costs and injected spikes`;

async function main(command: string | undefined): Promise<void> {
  if (command !== "seed" && command !== "demo") {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
    return;
  }
  const db = createClient();
  try {
    if (command === "seed") {
      const dataset = await seedMock(db);
      console.log(
        `Seeded ${dataset.costs.length} cost records and ${dataset.deploys.length} deploys ` +
          `(${dataset.start} → ${dataset.end}) with ${dataset.spikes.length} injected cost changes.`,
      );
    } else {
      await runDemo(db);
    }
  } finally {
    await db.$disconnect();
  }
}

main(process.argv[2]).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
