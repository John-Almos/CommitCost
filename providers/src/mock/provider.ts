import type { CostProvider, CostRecord, DateRange, Deploy, VcsProvider } from "@commitcost/core";
import { generateMockDataset, type MockDataset, type MockOptions } from "./generate.js";

function inRange(date: string, range: DateRange): boolean {
  const day = date.slice(0, 10);
  return day >= range.start && day <= range.end;
}

/** Serves generated AWS costs through the same interface as Cost Explorer. */
export class MockCostProvider implements CostProvider {
  readonly name = "mock";
  readonly dataset: MockDataset;

  constructor(datasetOrOptions: MockDataset | MockOptions = {}) {
    this.dataset = "costs" in datasetOrOptions ? datasetOrOptions : generateMockDataset(datasetOrOptions);
  }

  async getDailyCosts(range: DateRange): Promise<CostRecord[]> {
    return this.dataset.costs.filter((r) => inRange(r.date, range));
  }
}

/** Serves the generated merge history through the same interface as GitHub. */
export class MockVcsProvider implements VcsProvider {
  readonly name = "mock";
  readonly dataset: MockDataset;

  constructor(datasetOrOptions: MockDataset | MockOptions = {}) {
    this.dataset = "costs" in datasetOrOptions ? datasetOrOptions : generateMockDataset(datasetOrOptions);
  }

  async getDeploys(range: DateRange): Promise<Deploy[]> {
    return this.dataset.deploys.filter((d) => inRange(d.mergedAt, range));
  }
}
