import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "@/components/Nav";
import { dataMode } from "@/lib/data";
import "./globals.css";

export const metadata: Metadata = {
  title: "CommitCost",
  description: "Tie cloud cost changes to the commits that caused them.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const mode = await dataMode();
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
            <Nav />
            <span className="mode-pill">{mode === "mock" ? "Mock data · no credentials" : mode === "live" ? "Live AWS data" : "No data yet"}</span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
