"use client";

import { useSyncExternalStore } from "react";
import { applyTheme, currentTheme, THEME_BOOTSTRAP, type Theme } from "@/lib/theme";
import { IconMoon, IconSun } from "@/components/icons";

/**
 * Applies the saved theme before first paint.
 *
 * Inlined and run synchronously in <head>: doing this in an effect would
 * paint the light theme first and then swap, and that white flash on a
 * doctor's tablet in a dim room is exactly what dark mode is meant to avoid.
 *
 * `suppressHydrationWarning` because React does not execute script tags it
 * renders on the client and warns about them. That is fine here — the
 * document is only ever loaded once per navigation to a fresh page, and
 * client-side route changes keep the attribute already on <html>. Without
 * the suppression this logs an error on every page view.
 */
export function ThemeScript() {
  return (
    <script
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }}
    />
  );
}

/*
  The theme lives on <html data-theme>, written by ThemeScript before React
  ever runs. That makes it external state, so it is read with
  useSyncExternalStore rather than mirrored into an effect — the server
  snapshot returns null, which is what keeps SSR from committing to a value
  it cannot know.
*/
const themeStore = {
  subscribe(onChange: () => void) {
    const obs = new MutationObserver(onChange);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  },
  get: (): Theme => currentTheme(),
  server: (): Theme | null => null,
};

export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.get,
    themeStore.server,
  );

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      // No local state to update: applyTheme writes the attribute, the
      // observer above fires, and the component re-reads it.
      onClick={() => applyTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      // 44px, the smallest target a finger hits reliably (Fitts' Law, and
      // the WCAG 2.5.5 minimum). This sits in a header next to other
      // controls, so an undersized one is not just hard to hit — it is easy
      // to hit the wrong thing.
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full
        text-muted transition-colors hover:bg-[var(--hover)] hover:text-[var(--accent)]
        ${className}`}
      style={{ minHeight: 44, minWidth: 44 }}
    >
      {/* Invisible until known, so nothing flips after hydration. */}
      <span className={theme === null ? "opacity-0" : "opacity-100"}>
        {theme === "dark" ? (
          <IconSun className="h-[18px] w-[18px]" />
        ) : (
          <IconMoon className="h-[18px] w-[18px]" />
        )}
      </span>
    </button>
  );
}
