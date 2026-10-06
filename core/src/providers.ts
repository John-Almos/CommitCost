import type { CostRecord, Deploy, IsoDate } from "./types.js";

export interface DateRange {
  /** Inclusive. */
  start: IsoDate;
  /** Inclusive. */
  end: IsoDate;
}

/**
 * Source of daily cloud costs. AWS Cost Explorer and the mock generator
 * implement this; GCP or Azure billing exports can implement it later.
 */
export interface CostProvider {
  readonly name: string;
  getDailyCosts(range: DateRange): Promise<CostRecord[]>;
}

/** Source of changes merged to the default branch. */
export interface VcsProvider {
  readonly name: string;
  getDeploys(range: DateRange): Promise<Deploy[]>;
}
