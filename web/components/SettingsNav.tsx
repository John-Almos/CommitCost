"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/settings", label: "Overview" },
  { href: "/settings/aws", label: "AWS" },
  { href: "/settings/github", label: "GitHub" },
  { href: "/settings/members", label: "Members" },
];

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav className="side-nav" aria-label="Settings">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
