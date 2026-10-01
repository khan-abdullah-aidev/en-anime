// The debug logs print the full model payload, watch history included, so
// they're off unless you're running the dev server or opened the site with
// ?debug. That flag is remembered for the tab, since in-app navigation
// rewrites the URL and would otherwise drop it.
const DEBUG_KEY = "en.debug";

const enabled = (() => {
  try {
    if (new URLSearchParams(window.location.search).has("debug")) {
      sessionStorage.setItem(DEBUG_KEY, "1");
    }
    return Boolean(import.meta.env?.DEV) || sessionStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
})();

export function debugLog(...args) {
  if (enabled) console.log(...args);
}
