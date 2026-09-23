import Link from "next/link";
import { getSession } from "@/lib/http";
import { ThemeToggle } from "./theme-toggle";

/** Top nav. Session-aware: signed-in users get app links and a way out. */
export async function SiteHeader() {
  const session = await getSession().catch(() => null);
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
      <Link href="/" className="text-title font-semibold tracking-tight">
        Vyaya
      </Link>
      <nav className="flex items-center gap-4 text-small">
        {session ? (
          <>
            <Link href="/dashboard" className="text-muted hover:text-ink">
              Dashboard
            </Link>
            <Link href="/settings" className="text-muted hover:text-ink">
              Settings
            </Link>
            <a href="/api/auth/logout" className="text-muted hover:text-ink">
              Log out
            </a>
          </>
        ) : (
          <Link href="/login" className="text-muted hover:text-ink">
            Log in
          </Link>
        )}
        <ThemeToggle />
      </nav>
    </header>
  );
}
