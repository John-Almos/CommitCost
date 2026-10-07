import type { FileCostHistory } from "../codeMap.js";
import type { CalibrationTable } from "../receipts.js";
import type { CostAssumptions } from "./context.js";
import type { UsageProfile } from "./profile.js";

/**
 * A cost profile file: what the GitHub Action needs from your bill to
 * calibrate estimates, without cloud credentials in CI. Written by
 * `npm run profile`; contains usage volumes and rates, no secrets.
 */
export interface CostProfileFile {
  version: 1;
  generatedAt: string;
  region?: string;
  /** Name of the price book the list rates came from. */
  priceSource?: string;
  usage?: UsageProfile;
  assumptions?: Partial<CostAssumptions>;
  /** Per-detector corrections learned from cost receipts (predicted vs measured on merged PRs). */
  calibration?: CalibrationTable;
  /** Files whose past changes raised the bill, so the PR check can say so when they're touched again. */
  history?: FileCostHistory[];
}

export function parseCostProfile(json: string): CostProfileFile {
  const data = JSON.parse(json) as CostProfileFile;
  if (data.version !== 1) throw new Error(`Unsupported cost profile version ${String(data.version)}; re-export it with \`npm run profile\`.`);
  return data;
}
