export type Theme = "light" | "dark";

/*
  Theme is stored PER DEVICE, not per user and not on the server.

  That is the whole point: the same clinic runs a bright reception counter, a
  tablet in a consulting room, and a TV in a dim waiting area, and the right
  answer differs for each. A server-side preference would force one of them
  to be wrong.

  Reception's default stays light — the original bright-room reasoning is
  untouched for the machine it was written for.
*/
export const THEME_KEY = "tokgen.theme";

/** Runs before first paint (see ThemeScript) — keep it dependency-free. */
export const THEME_BOOTSTRAP = `
(function(){
  try {
    var t = localStorage.getItem(${JSON.stringify(THEME_KEY)});
    if (t !== "dark" && t !== "light") {
      t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
`;

export function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // A locked-down kiosk profile can refuse storage; the theme still
    // applies for this session, which is the part that matters on screen.
  }
}

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}
