"use client";

import { useEffect, useState } from "react";

/** Light/dark toggle. Persists to localStorage; default follows the OS. */
export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("vyaya-theme", next ? "dark" : "light");
    } catch {
      // Private mode: theme still toggles for the session.
    }
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-small text-muted shadow-(--shadow-interactive) hover:text-ink"
    >
      {dark === null ? "◐" : dark ? "☀" : "☾"}
    </button>
  );
}
