// Merging two copies of the log (this device's and the stored one), used by
// api/sync.js on the server and by the "load a log file" import. Pure, so the
// same rules apply everywhere:
//  - entries are matched by id; the one written most recently (updated_at,
//    else the date it was picked) wins,
//  - an entry deleted on either side stays deleted, unless it was changed
//    again after the deletion,
//  - clearing the log removes everything written before the clear,
//  - preferences are one object: the most recently changed copy wins.

const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const MAX_SYNCED_ENTRIES = 2000;

export function emptySnapshot() {
  return { version: 1, history: [], deleted: {}, clearedAt: "", preferences: null };
}

export function mergeSnapshots(local, remote, now = Date.now()) {
  const a = normalizeSnapshot(local);
  const b = normalizeSnapshot(remote);

  const clearedAt = latest(a.clearedAt, b.clearedAt);
  const clearedTime = time(clearedAt);

  const deleted = {};
  for (const [id, at] of [...Object.entries(a.deleted), ...Object.entries(b.deleted)]) {
    if (!deleted[id] || time(at) > time(deleted[id])) deleted[id] = at;
  }

  const byId = new Map();
  for (const entry of [...a.history, ...b.history]) {
    const current = byId.get(entry.id);
    if (!current || stamp(entry) > stamp(current)) byId.set(entry.id, entry);
  }

  const history = [...byId.values()]
    .filter((entry) => stamp(entry) > clearedTime)
    .filter((entry) => !(deleted[entry.id] && time(deleted[entry.id]) >= stamp(entry)))
    .sort((x, y) => time(y.date) - time(x.date))
    .slice(0, MAX_SYNCED_ENTRIES);

  // Old tombstones (and ones the clear already covers) have done their job.
  for (const [id, at] of Object.entries(deleted)) {
    if (now - time(at) > TOMBSTONE_TTL_MS || time(at) <= clearedTime) delete deleted[id];
  }

  const preferences =
    !a.preferences ? b.preferences
      : !b.preferences ? a.preferences
        : time(b.preferences.updatedAt) > time(a.preferences.updatedAt) ? b.preferences : a.preferences;

  return { version: 1, history, deleted, clearedAt, preferences };
}

export function normalizeSnapshot(value) {
  const snapshot = value && typeof value === "object" ? value : {};
  return {
    version: 1,
    history: (Array.isArray(snapshot.history) ? snapshot.history : []).filter(
      (entry) => entry && typeof entry.id === "string" && entry.recommendation && typeof entry.recommendation.title === "string"
    ),
    deleted: Object.fromEntries(
      Object.entries(snapshot.deleted && typeof snapshot.deleted === "object" ? snapshot.deleted : {}).filter(
        ([id, at]) => typeof id === "string" && typeof at === "string"
      )
    ),
    clearedAt: typeof snapshot.clearedAt === "string" ? snapshot.clearedAt : "",
    preferences: snapshot.preferences && typeof snapshot.preferences === "object" ? snapshot.preferences : null
  };
}

// Same content, regardless of key order? Cheap enough to compare as JSON,
// since both sides come out of normalizeSnapshot/mergeSnapshots.
export function sameSnapshot(a, b) {
  return JSON.stringify(normalizeSnapshot(a)) === JSON.stringify(normalizeSnapshot(b));
}

function stamp(entry) {
  return time(entry.updated_at) || time(entry.date);
}

function time(value) {
  return Date.parse(value || "") || 0;
}

function latest(x, y) {
  return time(y) > time(x) ? y : x;
}
