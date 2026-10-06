import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { currentWorkspace } from "@/lib/auth";
import { dataMode } from "@/lib/data";
import { isLocalMode } from "@/lib/platform";
import { signOut } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "CommitCost",
  description: "Tie cloud cost changes to the commits that caused them.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const ws = await currentWorkspace();
  const mode = ws ? (ws.org.isDemo ? "demo" : await dataMode(ws.org.id)) : null;
  return (
    <html lang="en">
      <body>
        <header className="header">
          <div className="header-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden>
                $
              </span>
              CommitCost
            </Link>
            {ws && <WorkspaceSwitcher key={ws.org.id} current={ws.org.id} options={ws.all.map((o) => ({ id: o.id, name: o.name }))} />}
            {ws && <Nav />}
            <div className="header-right">
              {mode && (
                <span className="mode-pill">
                  {mode === "demo" ? "Mock data · no credentials" : mode === "live" ? "Live AWS data" : "Waiting for first sync"}
                </span>
              )}
              {ws && !isLocalMode() && (
                <form action={signOut} className="user-menu">
                  {ws.user.avatarUrl && <img src={ws.user.avatarUrl} alt="" width={22} height={22} />}
                  <span className="ink2">{ws.user.login}</span>
                  <button type="submit" className="link-button">
                    Sign out
                  </button>
                </form>
              )}
            </div>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
