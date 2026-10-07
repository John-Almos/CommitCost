"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview", match: (p: string) => p === "/" || p.startsWith("/anomalies") },
  { href: "/changes", label: "Changes", match: (p: string) => p.startsWith("/changes") },
  { href: "/pr-check", label: "PR check", match: (p: string) => p.startsWith("/pr-check") },
  { href: "/receipts", label: "Receipts", match: (p: string) => p.startsWith("/receipts") },
  { href: "/code-map", label: "Code map", match: (p: string) => p.startsWith("/code-map") },
  { href: "/cost-model", label: "Cost model", match: (p: string) => p.startsWith("/cost-model") },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={l.match(path) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
