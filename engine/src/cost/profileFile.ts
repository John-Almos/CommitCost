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
}

export function parseCostProfile(json: string): CostProfileFile {
  const data = JSON.parse(json) as CostProfileFile;
  if (data.version !== 1) throw new Error(`Unsupported cost profile version ${String(data.version)}; re-export it with \`npm run profile\`.`);
  return data;
}
