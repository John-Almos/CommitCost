"use client";

import { useActionState, useState } from "react";
import { checkDiff, type CheckResult } from "@/app/pr-check/actions";
import { WarningCard } from "./ui";

export interface Example {
  id: string;
  label: string;
  diff: string;
}

export function PrCheck({ examples, initial }: { examples: Example[]; initial: string }) {
  const [diff, setDiff] = useState(examples.find((e) => e.id === initial)?.diff ?? "");
  const [picked, setPicked] = useState(initial);
  const [result, action, pending] = useActionState<CheckResult | null, FormData>(checkDiff, null);

  return (
    <div className="layout-main pr-check-layout">
      <form action={action} className="card stack">
        <div>
          <div className="tile-label" style={{ marginBottom: 6 }}>
            Start from an example
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {examples.map((e) => (
              <button
                key={e.id}
                type="button"
                className="button secondary"
                aria-current={picked === e.id ? "true" : undefined}
                onClick={() => {
                  setDiff(e.diff);
                  setPicked(e.id);
                }}
              >
                {e.label}
              </button>
            ))}
          </div>
        </div>
        <label>
          <div className="tile-label" style={{ marginBottom: 6 }}>
            Diff (output of <code>git diff</code>)
          </div>
          <textarea
            name="diff"
            value={diff}
            spellCheck={false}
            onChange={(e) => {
              setDiff(e.target.value);
              setPicked("");
            }}
            style={{ minHeight: 360 }}
          />
        </label>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button type="submit" disabled={pending || !diff.trim()}>
            {pending ? "Checking…" : "Check for cost risks"}
          </button>
          <label className="ink2" style={{ fontSize: 13 }}>
            Min confidence{" "}
            <select name="minConfidence" defaultValue="0.6">
              <option value="0.4">0.4</option>
              <option value="0.6">0.6 (Action default)</option>
              <option value="0.8">0.8</option>
            </select>
          </label>
        </div>
      </form>

      <aside className="card">
        <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Result</h3>
        {!result ? (
          <p className="muted" style={{ margin: 0 }}>
            Pick an example or paste a diff, then run the check.
          </p>
        ) : result.error ? (
          <div className="callout">{result.error}</div>
        ) : (
          <>
            <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
              {result.files.length} file{result.files.length === 1 ? "" : "s"} reviewed ·{" "}
              {result.warnings.length === 0 ? "no cost risks" : `${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`}
            </p>
            {result.warnings.length === 0 ? (
              <div className="callout">✅ No cost risks found. The Action stays quiet on this PR.</div>
            ) : (
              result.warnings.map((w, i) => <WarningCard key={`${w.file}:${w.line}:${w.detector}`} w={w} n={i + 1} />)
            )}
            <details style={{ marginTop: 12 }} open={result.warnings.length > 0}>
              <summary>PR comment the Action posts</summary>
              <pre className="comment-preview">{result.comment}</pre>
            </details>
          </>
        )}
      </aside>
    </div>
  );
}
