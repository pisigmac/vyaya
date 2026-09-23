"use client";

import { useEffect, useState } from "react";

/** Light/dark toggle. Persists to localStorage; the layout script reads it. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("vyaya-theme", next ? "dark" : "light");
    } catch {
      // Private mode: the class toggle still applies for this session.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="rounded-md border border-border bg-surface px-3 py-1.5 text-small text-ink shadow-(--shadow-interactive) hover:border-muted"
    >
      {dark ? "Light mode" : "Dark mode"}
    </button>
  );
}
