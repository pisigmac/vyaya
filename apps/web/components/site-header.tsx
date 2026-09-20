"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/onboarding", label: "Setup" },
  { href: "/settings", label: "Settings" },
] as const;

/** Top bar: wordmark, nav (signed-in only), theme toggle, auth action. */
export function SiteHeader() {
  const pathname = usePathname();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((res) => setSignedIn(res.ok))
      .catch(() => setSignedIn(false));
  }, [pathname]);

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
        <Link href="/" className="text-body font-semibold tracking-tight">
          vyaya
        </Link>
        {signedIn ? (
          <nav className="flex items-center gap-5">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`text-small ${
                  pathname.startsWith(item.href)
                    ? "font-semibold text-ink"
                    : "text-muted hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            ))}
            <a
              href="/api/auth/logout"
              className="text-small text-muted hover:text-ink"
            >
              Log out
            </a>
          </nav>
        ) : null}
        <ThemeToggle />
      </div>
    </header>
  );
}
