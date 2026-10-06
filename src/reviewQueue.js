// Which earlier picks "Did you watch X?" asks about, and when.
//
// A pick waits for an answer while it's unrated (shown, never answered),
// saved for later ("pending"), or being watched ("watching"). Saying
// "watching it" or "I'll watch it later" snoozes the question instead of
// having it come back every visit: ask_after is when it may be asked again.
// "Not now" (or En's wordmark) answers nothing and only waits out tonight.
// MAL/AniList can still answer it meanwhile (see answersFromList).
const DAY = 24 * 60 * 60 * 1000;
export const ASK_AGAIN_DAYS = { watching: 14, later: 30, notNow: 0.5 };

export function isAwaitingAnswer(entry) {
  return entry.state === "unrated" || entry.state === "pending" || entry.state === "watching";
}

export function isSnoozed(entry, now = Date.now()) {
  return Boolean(entry.ask_after) && Date.parse(entry.ask_after) > now;
}

// When to ask again after this answer, or null to ask on the next visit.
export function askAgainAfter(answer, now = Date.now()) {
  const days = ASK_AGAIN_DAYS[answer];
  return days ? new Date(now + days * DAY).toISOString() : null;
}

// Picks from earlier visits that are due an answer, oldest first.
export function findReviewEntries(history, sessionIds = new Set(), now = Date.now()) {
  return history
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isAwaitingAnswer(entry) && !sessionIds.has(entry.id) && !isSnoozed(entry, now))
    .sort((a, b) => {
      const timeA = Date.parse(a.entry.date);
      const timeB = Date.parse(b.entry.date);

      if (Number.isNaN(timeA) && Number.isNaN(timeB)) return b.index - a.index;
      if (Number.isNaN(timeA)) return 1;
      if (Number.isNaN(timeB)) return -1;
      return timeA - timeB;
    })
    .map(({ entry }) => entry);
}

export function findCurrentPending(history, pendingReviewIds, sessionIds, now = Date.now()) {
  const due = new Map(findReviewEntries(history, sessionIds, now).map((entry) => [entry.id, entry]));
  return pendingReviewIds.map((id) => due.get(id)).find(Boolean) || [...due.values()][0];
}
