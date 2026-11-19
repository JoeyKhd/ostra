"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "dark" | "light";

const currentTheme = (): Theme => (document.documentElement.dataset["theme"] === "light" ? "light" : "dark");

/** The theme toggle: its label is the theme it switches to. The choice is kept in localStorage. */
export const ThemeToggle = () => {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    setTheme(currentTheme());
  }, []);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="icon-button needs-js"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        document.documentElement.dataset["theme"] = next;
        try {
          localStorage.setItem("theme", next);
        } catch {
          // Storage can be blocked; the theme still changes for this page.
        }
        setTheme(next);
      }}
    >
      {theme === "dark" ? <Moon size={16} strokeWidth={1.75} aria-hidden="true" /> : <Sun size={16} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
};
