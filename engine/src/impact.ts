import { costContext, type CostContext, type CostContextInput } from "./cost/context.js";
import { estimateCost } from "./cost/estimate.js";
import type { CostEstimate } from "./cost/types.js";
import type { DiffFinding } from "./diff/types.js";

/**
 * Monthly cost of a diff finding, from the cost model in ./cost: unit prices
 * from the price book, volumes from the diff or your bill, and labeled
 * assumptions for anything neither states.
 */
export interface ImpactEstimate {
  /** One line, e.g. "≈ +$4,485/month". */
  summary: string;
  /** Point estimate (or upper bound) when the inputs allow one. */
  monthlyUsd?: number;
  /** The assumptions as one sentence, for compact displays. */
  assumptions: string;
  /** The full calculation: formula, labeled inputs, assumptions. */
  estimate: CostEstimate;
}

/** A ready context, or the parts to build one (price book, region, usage profile, assumption overrides). */
export type ImpactContext = CostContext | CostContextInput;

const isContext = (c: ImpactContext): c is CostContext => "configured" in c && "prices" in c && !!c.prices;

export function toCostContext(ctx: ImpactContext = {}): CostContext {
  return isContext(ctx) ? ctx : costContext(ctx);
}

export function estimateImpact(f: DiffFinding, ctx: ImpactContext = {}, patch?: string): ImpactEstimate {
  const estimate = estimateCost(f, toCostContext(ctx), { patch });
  return {
    summary: estimate.summary,
    monthlyUsd: estimate.monthlyUsd,
    assumptions: estimate.assumptions.join(" "),
    estimate,
  };
}
