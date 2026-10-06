"use client";

import { useRef } from "react";
import { switchWorkspace } from "@/app/actions";

export function WorkspaceSwitcher({ current, options }: { current: string; options: { id: string; name: string }[] }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={switchWorkspace} className="ws-switch">
      <label className="sr-only" htmlFor="ws-select">
        Workspace
      </label>
      <select id="ws-select" name="orgId" defaultValue={current} onChange={() => form.current?.requestSubmit()}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <a className="ws-new" href="/onboarding">
        + New
      </a>
      <noscript>
        <button type="submit">Switch</button>
      </noscript>
    </form>
  );
}
