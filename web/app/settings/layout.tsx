import type { ReactNode } from "react";
import { SettingsNav } from "@/components/SettingsNav";
import { requireWorkspace } from "@/lib/auth";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { org } = await requireWorkspace();
  return (
    <>
      <h1>Settings</h1>
      <p className="sub">{org.isDemo ? "The demo workspace runs on generated data. Create your own workspace to connect AWS and GitHub." : `Connections and people for ${org.name.replace(/\.$/, "")}.`}</p>
      <div className="settings-layout">
        <SettingsNav />
        <div className="stack">{children}</div>
      </div>
    </>
  );
}
