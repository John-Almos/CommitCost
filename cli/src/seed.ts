import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearOrgData, ensureDemoOrg, saveCostRecords, saveDeploys, type Organization, type PrismaClient } from "@commitcost/db";
import { MockCostProvider, MockVcsProvider, generateMockDataset, type MockDataset, type MockOptions } from "@commitcost/providers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const GROUND_TRUTH_PATH = resolve(repoRoot, ".commitcost/mock-ground-truth.json");

/**
 * Loads mock data through the provider interfaces (the same path real AWS and
 * GitHub data take) into the Demo workspace. Also writes the injected spikes
 * to a JSON file so results can be checked against ground truth.
 */
export async function seedMock(db: PrismaClient, options: MockOptions = {}): Promise<MockDataset & { org: Organization }> {
  const org = await ensureDemoOrg(db);
  const dataset = generateMockDataset(options);
  const range = { start: dataset.start, end: dataset.end };
  const costs = await new MockCostProvider(dataset).getDailyCosts(range);
  const deploys = await new MockVcsProvider(dataset).getDeploys(range);

  await clearOrgData(db, org.id);
  await saveCostRecords(db, org.id, costs);
  await saveDeploys(db, org.id, deploys);

  mkdirSync(dirname(GROUND_TRUTH_PATH), { recursive: true });
  writeFileSync(
    GROUND_TRUTH_PATH,
    JSON.stringify({ seed: dataset.seed, start: dataset.start, end: dataset.end, spikes: dataset.spikes, unexplained: dataset.unexplained }, null, 2),
  );
  return { ...dataset, org };
}
