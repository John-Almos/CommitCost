import { db } from "./db";

/** What a workspace has connected so far, for the setup checklist and settings. */
export async function getSetupState(orgId: string) {
  const [aws, installations, repos, runs, costRows] = await Promise.all([
    db.awsConnection.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } }),
    db.gitHubInstallation.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } }),
    db.trackedRepo.findMany({ where: { orgId }, orderBy: { fullName: "asc" } }),
    db.syncRun.findMany({ where: { orgId }, orderBy: { queuedAt: "desc" }, take: 5 }),
    db.costRecord.count({ where: { orgId } }),
  ]);
  const lastRun = runs[0] ?? null;
  const lastSuccess = runs.find((r) => r.status === "succeeded") ?? null;
  return {
    aws,
    installations,
    repos,
    runs,
    lastRun,
    lastSuccess,
    hasData: costRows > 0,
    awsDone: aws.length > 0,
    githubDone: repos.length > 0,
    syncing: lastRun?.status === "queued" || lastRun?.status === "running",
  };
}

export type SetupState = Awaited<ReturnType<typeof getSetupState>>;
