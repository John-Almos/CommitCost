import { SAMPLE_PRS } from "@commitcost/action";
import { PrCheck, type Example } from "@/components/PrCheck";
import { requireWorkspace } from "@/lib/auth";
import { listChanges } from "@/lib/data";
import { toGitDiff } from "@/lib/diffText";

export const dynamic = "force-dynamic";

export default async function PrCheckPage({ searchParams }: { searchParams: Promise<{ example?: string }> }) {
  const { example } = await searchParams;
  const samples: Example[] = Object.entries(SAMPLE_PRS).map(([id, pr]) => ({
    id,
    label: pr.title,
    diff: toGitDiff(pr.files.map((f) => ({ path: f.filename, patch: f.patch }))),
  }));
  // Past PRs that caused cost changes make good examples too.
  const { org } = await requireWorkspace();
  const past = (await listChanges(org.id))
    .filter((c) => c.warnings > 0)
    .slice(0, 4)
    .map((c) => ({ id: c.sha.slice(0, 12), label: `#${c.prNumber ?? c.sha.slice(0, 7)} ${c.title}`, diff: toGitDiff(c.files) }));
  const examples = [...samples, ...past];

  return (
    <>
      <h1>PR check</h1>
      <p className="sub">The same review the CommitCost GitHub Action runs before merge. Paste a diff to see what it would comment.</p>
      <PrCheck examples={examples} initial={examples.some((e) => e.id === example) ? example! : "nPlusOne"} />
    </>
  );
}
