import { readFileSync } from "node:fs";
import { parseCostProfile, type CostAssumptions, type CostContextInput } from "@commitcost/engine";

/** Builds the cost-model input from the Action's inputs. Explicit inputs win over the profile file. */
export function readCostProfileFile(path: string | undefined, inputs: { region?: string; assumptions?: string } = {}): CostContextInput {
  const file = path ? parseCostProfile(readFileSync(path, "utf8")) : undefined;
  let assumptions: Partial<CostAssumptions> | undefined;
  try {
    assumptions = inputs.assumptions ? (JSON.parse(inputs.assumptions) as Partial<CostAssumptions>) : undefined;
  } catch {
    throw new Error('assumptions must be a JSON object, e.g. {"cacheHitRate":0.9}');
  }
  return {
    region: inputs.region || file?.region,
    usage: file?.usage,
    assumptions: { ...file?.assumptions, ...assumptions },
  };
}
