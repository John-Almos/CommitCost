import { readFileSync } from "node:fs";
import { parseCostProfile, type CalibrationTable, type CostAssumptions, type CostContextInput, type FileCostHistory } from "@commitcost/engine";

export interface ProfileInputs {
  cost: CostContextInput;
  calibration?: CalibrationTable;
  history?: FileCostHistory[];
}

/** Builds the cost-model input from the Action's inputs. Explicit inputs win over the profile file. */
export function readCostProfileFile(path: string | undefined, inputs: { region?: string; assumptions?: string } = {}): CostContextInput {
  return readProfile(path, inputs).cost;
}

/** The cost-model input plus what the profile learned from your history: detector corrections and costly files. */
export function readProfile(path: string | undefined, inputs: { region?: string; assumptions?: string } = {}): ProfileInputs {
  const file = path ? parseCostProfile(readFileSync(path, "utf8")) : undefined;
  let assumptions: Partial<CostAssumptions> | undefined;
  try {
    assumptions = inputs.assumptions ? (JSON.parse(inputs.assumptions) as Partial<CostAssumptions>) : undefined;
  } catch {
    throw new Error('assumptions must be a JSON object, e.g. {"cacheHitRate":0.9}');
  }
  return {
    cost: {
      region: inputs.region || file?.region,
      usage: file?.usage,
      assumptions: { ...file?.assumptions, ...assumptions },
    },
    calibration: file?.calibration,
    history: file?.history,
  };
}
