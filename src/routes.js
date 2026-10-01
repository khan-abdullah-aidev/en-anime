// Screens <-> URLs, so the browser's back/forward buttons, the phone back
// gesture and reloads all work. Vercel already serves index.html for any
// path (see vercel.json), so these need nothing on the server.

export const VIEW = {
  LANDING: "landing",
  MANUAL: "manual",
  PENDING: "pending",
  MOOD: "mood",
  SHORTLIST: "shortlist",
  SHORTLIST_MOOD: "shortlist_mood",
  THINKING: "thinking",
  REVEAL: "reveal",
  FEEDBACK: "feedback",
  HISTORY: "history"
};

const PATHS = {
  [VIEW.LANDING]: "/",
  [VIEW.MANUAL]: "/your-list",
  [VIEW.PENDING]: "/before-tonight",
  [VIEW.MOOD]: "/tonight",
  [VIEW.SHORTLIST]: "/considering",
  [VIEW.SHORTLIST_MOOD]: "/considering/why",
  [VIEW.HISTORY]: "/log"
};

// Where "← back" goes when there's no earlier page in this tab to return to,
// e.g. a pick opened in a new tab from the log. null = no back button.
export const PARENT = {
  [VIEW.LANDING]: null,
  [VIEW.MANUAL]: VIEW.LANDING,
  [VIEW.PENDING]: null,
  [VIEW.MOOD]: null,
  [VIEW.SHORTLIST]: VIEW.MOOD,
  [VIEW.SHORTLIST_MOOD]: VIEW.SHORTLIST,
  [VIEW.THINKING]: null,
  [VIEW.REVEAL]: VIEW.HISTORY,
  [VIEW.FEEDBACK]: VIEW.REVEAL,
  [VIEW.HISTORY]: VIEW.MOOD
};

// The thinking screen has no address of its own: it sits on top of the page
// that started the request, so a reload mid-request lands back there.
export function pathFor(view, entryId) {
  if (view === VIEW.REVEAL) return `/pick/${encodeURIComponent(entryId)}`;
  if (view === VIEW.FEEDBACK) return `/pick/${encodeURIComponent(entryId)}/seen`;
  return PATHS[view] || "/";
}

export function parsePath(pathname) {
  const clean = String(pathname || "/").replace(/\/+$/, "") || "/";
  const pick = clean.match(/^\/pick\/([^/]+)(\/seen)?$/);
  if (pick) {
    return { view: pick[2] ? VIEW.FEEDBACK : VIEW.REVEAL, entryId: decodeURIComponent(pick[1]) };
  }
  const view = Object.keys(PATHS).find((key) => PATHS[key] === clean);
  return { view: view || VIEW.LANDING };
}
