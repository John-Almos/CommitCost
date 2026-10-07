import { loadCodeowners, loadDeploys, loadTopAttributions } from "@commitcost/db";
import {
  buildReceipts,
  codeMapFrom,
  costHistory,
  fixFor,
  learnCalibration,
  receiptStats,
  type CostFix,
  type HistoryInput,
} from "@commitcost/engine";
import { priceBook, usageRecords } from "./cost";
import { db } from "./db";

/** Stored deploys, rank-1 attributions and usage: the inputs to receipts, the code cost map and fix patches. */
async function historyInput(): Promise<HistoryInput & { codeowners?: string }> {
  const [deploys, attributions, usage, codeowners] = await Promise.all([loadDeploys(db), loadTopAttributions(db), usageRecords(), loadCodeowners(db)]);
  const dataEnd = usage.reduce<string | undefined>((m, u) => (!m || u.date > m ? u.date : m), undefined) ?? new Date().toISOString().slice(0, 10);
  return { deploys, attributions, usage, prices: priceBook(), dataEnd, codeowners };
}

export async function getReceipts() {
  const input = await historyInput();
  const receipts = buildReceipts(input);
  return { receipts, calibration: learnCalibration(receipts), stats: receiptStats(receipts), dataEnd: input.dataEnd };
}

export async function getCodeMap() {
  const input = await historyInput();
  return { map: codeMapFrom(input.deploys, input.attributions, input.codeowners), hasCodeowners: !!input.codeowners };
}

/** The fix patch for an anomaly's top suspect, when it's a confidently attributed increase. */
export async function getFix(commitSha: string): Promise<CostFix | null> {
  const input = await historyInput();
  const deploy = input.deploys.find((d) => d.commitSha === commitSha);
  return deploy ? fixFor(deploy, input.attributions, input.deploys) : null;
}

/** What the exported cost profile would carry into the GitHub Action: learned corrections and costly files. */
export async function getLearnedProfile() {
  const input = await historyInput();
  return {
    calibration: learnCalibration(buildReceipts(input)),
    history: costHistory(codeMapFrom(input.deploys, input.attributions, input.codeowners)),
  };
}
