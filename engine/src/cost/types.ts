/**
 * The shape of every cost estimate: a formula, the inputs that went into it
 * (each labeled with where it came from), and the assumptions that would move
 * it. Nothing in an estimate is a bare number.
 */

/** Where an input value came from, strongest first. */
export type InputSource =
  /** Stated in the diff itself, e.g. `desired_capacity = 3`. */
  | "diff"
  /** Your own bill: Cost Explorer usage and cost by usage type. */
  | "usage"
  /** A unit price from the cloud's price list (bundled snapshot or live API). */
  | "price-list"
  /** Set explicitly in CommitCost's configuration. */
  | "config"
  /** CommitCost's default when nothing better is known. Override it in config. */
  | "default";

export interface EstimateInput {
  /** What it is, e.g. "m5.2xlarge on-demand price". */
  label: string;
  value: number | string;
  /** Unit of `value`, e.g. "$/hour", "instances", "GB/month". */
  unit?: string;
  source: InputSource;
  /** Where exactly: a usage type, a price-list key, a config key, a diff line. */
  ref?: string;
}

/** How the headline number was reached. */
export type EstimateBasis =
  /** Diff values × list prices. */
  | "list-price"
  /** Usage volumes from your bill × list or effective prices. */
  | "usage-calibrated"
  /** A price per unit of traffic; multiply by your own volume. */
  | "per-unit"
  /** Direction is known, magnitude isn't. */
  | "qualitative";

export interface CostEstimate {
  basis: EstimateBasis;
  /** Expected monthly change, when it can be computed. Negative is a saving. */
  monthlyUsd?: number;
  /** When the estimate is a bound or the inputs are uncertain. */
  range?: { lowUsd: number; highUsd: number };
  /** For per-unit estimates: cost per `per` of traffic, e.g. per million requests. */
  perUnit?: { usd: number; per: string };
  /** The calculation in words and symbols, e.g. "3 instances × ($0.384 − $0.192)/h × 730 h". */
  formula: string;
  inputs: EstimateInput[];
  assumptions: string[];
  /** When the bill disagrees with what the diff alone implies. */
  calibration?: { diffOnlyMonthlyUsd: number; note: string };
  region: string;
  /** Price book used, e.g. "AWS list prices (bundled snapshot, 2026-10-06)". */
  priceSource: string;
  /** One line for tables, e.g. "≈ +$4,485/month". */
  summary: string;
}
