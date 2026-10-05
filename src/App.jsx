import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { askEn, askEnChoose, askEnTogether, askEnVerdict } from "./openrouter.js";
import { isEnConfigError } from "./llmProviders.js";
import { beginMalOauth, finishMalOauth, refreshMalOauth } from "./oauth.js";
import { MalAuthError, fetchAnimeImage, fetchAnimeList, fetchPartnerList, isMalAuthError, updateMalListStatus } from "./mal.js";
import { ANIME_CATALOG } from "./animeCatalog.js";
import {
  appendHistory,
  clearRecommendationLog,
  clearTokens,
  deleteHistoryEntry,
  loadRecommendationMemoryCache,
  loadManualList,
  loadHistory,
  loadPartner,
  loadListSource,
  loadActiveMode,
  loadTasteProfileCache,
  loadTokens,
  patchHistoryEntries,
  recordRecommendedAnime,
  saveManualList,
  savePartner,
  saveListSource,
  saveActiveMode,
  saveRecommendationMemoryCache,
  saveTasteProfileCache,
  updateHistoryEntry
} from "./storage.js";
import {
  buildRecommendationMemory,
  buildUnwatchedTitles,
  deterministicRecommendation,
  findBlockedEvidenceTitle,
  findCandidateByRecommendation,
  isMemoryExcludedTitle
} from "./recommendationEngine.js";
import {
  buildTasteProfile,
  compactFeedbackHistory,
  describeGenreAffinity,
  summarizeRecentPatterns
} from "./tasteProfile.js";
import { answersFromList, buildWatchHistoryDigest, describeQueriedTitle } from "./watchHistory.js";
import { buildOpenCandidatePool, buildTogetherPool, seedBench, toModelCandidate } from "./discovery.js";
import { animeTitleKeys, normalizeTitleForCompare, titleMatchesAnime, uniqueTitles } from "./titleUtils.js";
import { resolveAnimeOnAniList } from "./anilist.js";
import { PARENT, VIEW, parsePath, pathFor } from "./routes.js";
import { fetchPublicList, sourceLabel } from "./lists.js";
import { debugLog } from "./debug.js";
import {
  EXCLUDABLE,
  GENRE_OPTIONS,
  NOTES_LIMIT,
  applyTasteCorrections,
  exclusionFilter,
  loadPreferences,
  updatePreferences,
  userSaidFor
} from "./preferences.js";
import {
  applyRemoteSnapshot,
  deleteRemoteSnapshot,
  exportLogBlob,
  fetchRemoteSnapshot,
  generateSyncCode,
  importLogText,
  loadSyncSettings,
  localSnapshot,
  normalizeSyncCode,
  pushSnapshot,
  saveSyncSettings,
  syncAvailable
} from "./sync.js";
import { normalizeSnapshot } from "./syncMerge.js";
import { sharePick } from "./shareCard.js";
import { askAgainAfter, findCurrentPending, findReviewEntries, isAwaitingAnswer } from "./reviewQueue.js";
import { readMood } from "./moodReading.js";
import { buildTasteModel, describeModel, featuresOf, hitRate, learnedForModel, learnedRanker } from "./learning.js";
import { backfillPastPicks, needsBackfill, scoreDeltas } from "./learningBackfill.js";
import {
  createRoom,
  fetchRoom,
  loadMyName,
  loadRoom,
  newRoomKey,
  partnerListFromRoom,
  roomLink,
  saveMyName,
  saveRoom,
  trimListForRoom,
  updateRoom
} from "./rooms.js";

// Lets the header (wordmark, "← back") reach navigation without threading
// it through every screen.
const NavContext = createContext(null);

const MAX_RECOMMENDATION_ATTEMPTS = 3;
// A big MAL list is several sequential API pages, so reuse it for a while
// within one visit instead of refetching for every request.
const MAL_LIST_TTL_MS = 10 * 60 * 1000;
const MOOD_DRAFT_KEY = "en.moodDraft";

// Works out what a URL (or a browser-history entry) should show right now.
// Used on first load and on back/forward; in-app navigation calls go().
function resolveRoute(target, { initial = false, sessionIds = new Set() } = {}) {
  const hasInput = hasRecommendationInput();
  const home = () => {
    if (!hasInput) return { view: VIEW.LANDING };
    return findReviewEntries(loadHistory(), sessionIds).length ? { view: VIEW.PENDING } : { view: VIEW.MOOD };
  };
  const { view, entryId, titles, roomId } = target || {};

  // A request can't survive a reload or back/forward; land where it started.
  if (!view || view === VIEW.THINKING) return home();
  // Returning visitors skip the landing page, MAL or manual list alike.
  if (view === VIEW.LANDING) return initial && hasInput ? home() : { view };
  if (view === VIEW.REVEAL || view === VIEW.FEEDBACK) {
    return loadHistory().some((entry) => entry.id === entryId) ? { view, entryId } : { view: VIEW.HISTORY };
  }
  if (view === VIEW.HISTORY || view === VIEW.MANUAL || view === VIEW.USERNAME) return { view };
  // Someone opening a "two phones" link may not use En yet.
  if (view === VIEW.ROOM) return roomId ? { view, roomId } : home();
  if (!hasInput) return { view: VIEW.LANDING };
  if (view === VIEW.SHORTLIST_MOOD && !titles?.length) return { view: VIEW.SHORTLIST };
  if (view === VIEW.TOGETHER_MOOD && !loadPartner()) return { view: VIEW.TOGETHER };
  if (view === VIEW.PENDING && !findReviewEntries(loadHistory(), sessionIds).length) return { view: VIEW.MOOD };
  return { view, titles };
}

function initialRoute() {
  if (window.location.pathname === "/callback") return { view: VIEW.LANDING };
  const saved = window.history.state;
  return resolveRoute(saved?.view ? saved : parsePath(window.location.pathname), { initial: true });
}

// Pushes or replaces a browser-history entry for a screen and returns its
// position, which is how "← back" knows whether there's anywhere to go.
function writeHistory(method, { view, entryId = null, titles, roomId = null }) {
  // Remember how far down the page you were, so "back" returns there.
  if (method === "push" && window.history.state) {
    window.history.replaceState({ ...window.history.state, scrollY: window.scrollY }, "");
  }
  const currentIdx = window.history.state?.idx ?? 0;
  const idx = method === "push" ? currentIdx + 1 : currentIdx;
  const url = view === VIEW.THINKING ? window.location.pathname : pathFor(view, view === VIEW.ROOM ? roomId : entryId);
  const state = { view, entryId, ...(titles ? { titles } : {}), ...(roomId ? { roomId } : {}), idx };
  window.history[method === "push" ? "pushState" : "replaceState"](state, "", url);
  return idx;
}

export default function App() {
  const [initial] = useState(initialRoute);
  const [view, setView] = useState(initial.view);
  const [revealEntryId, setRevealEntryId] = useState(initial.entryId || null);
  const [routeIdx, setRouteIdx] = useState(() => window.history.state?.idx ?? 0);
  const [tokens, setTokens] = useState(() => loadTokens());
  const [history, setHistory] = useState(() => loadHistory());
  const [mood, setMood] = useState(() => readSession(MOOD_DRAFT_KEY));
  const [shortlist, setShortlist] = useState("");
  const [shortlistTitles, setShortlistTitles] = useState(initial.titles || []);
  const [chooseMood, setChooseMood] = useState("");
  const [partner, setPartner] = useState(() => loadPartner());
  const [togetherMood, setTogetherMood] = useState("");
  const [checkingPartner, setCheckingPartner] = useState(false);
  const [manualList, setManualList] = useState(() => loadManualList());
  const [mode, setMode] = useState(initialMode);
  const [checkingUsername, setCheckingUsername] = useState(false);
  const [malList, setMalList] = useState([]);
  const [pendingReviewIds, setPendingReviewIds] = useState([]);
  const [status, setStatus] = useState("");
  const [thinkingMood, setThinkingMood] = useState("");
  // How En heard tonight's mood ("quiet and a little sad"), once it has.
  const [heardMood, setHeardMood] = useState("");
  // "For two, from two phones": the room on screen, and what the server says.
  const [roomId, setRoomId] = useState(initial.roomId || null);
  const [room, setRoom] = useState({ status: "idle" });
  const [joiningRoom, setJoiningRoom] = useState(false);
  const roomBusy = useRef(false);
  // Looking up En's past picks so they teach it too (learningBackfill.js).
  const [catchingUp, setCatchingUp] = useState(false);
  const catchUpRunning = useRef(false);
  const [error, setError] = useState("");
  // What the user has told En directly (preferences.js).
  const [preferences, setPreferences] = useState(() => loadPreferences());
  // A quiet message at the foot of the screen: { kind: "info", text } or
  // the one-time MyAnimeList offer, { kind: "mal-offer", items }.
  const [notice, setNotice] = useState(null);
  const [knows, setKnows] = useState({ status: "idle" });
  const [syncSettings, setSyncSettings] = useState(() => loadSyncSettings());
  const [syncState, setSyncState] = useState({ available: null, busy: false, error: "" });
  const handledCallback = useRef(false);
  // The last snapshot the server confirmed, so a sync only runs when
  // something here has changed since.
  const lastSyncedSnapshot = useRef("");
  const syncTimer = useRef(null);
  const syncing = useRef(false);
  const syncAgain = useRef(false);
  const lastSyncAt = useRef(0);
  // Picks revealed in this visit. "Did you watch it?" is only asked about
  // picks from earlier visits, never one the user was just handed.
  const sessionEntryIds = useRef(new Set());
  const malListCache = useRef(null);
  const partnerListCache = useRef(null);
  // The screen showing right now, for async work that finishes later.
  const viewRef = useRef(view);
  viewRef.current = view;
  // Bumped whenever the user leaves a request (back, LOG, ...). A late answer
  // from an abandoned request is dropped instead of popping up a pick.
  const activeRequest = useRef(0);
  // Set just before stepping back off a failed request so its error survives.
  const keepErrorOnPop = useRef(false);
  // Set by showRoute for the arrival effect: where to scroll once it renders.
  const arrival = useRef(null);
  const [arrivals, setArrivals] = useState(0);

  const revealEntry = history.find((entry) => entry.id === revealEntryId) || null;

  // Give the first screen its proper URL and history entry.
  useEffect(() => {
    if (window.location.pathname === "/callback") return;
    writeHistory("replace", initial);
  }, []);

  useEffect(() => {
    function onPopState(event) {
      activeRequest.current += 1;
      const target = event.state?.view ? event.state : parsePath(window.location.pathname);
      const route = resolveRoute(target, { sessionIds: sessionEntryIds.current });
      if (!keepErrorOnPop.current) setError("");
      keepErrorOnPop.current = false;
      if (route.view !== target.view || (route.entryId || null) !== (target.entryId || null)) {
        writeHistory("replace", route);
      }
      // A phone's back swipe already animates; don't animate on top of it.
      showRoute(route, window.history.state?.idx ?? 0, {
        scrollY: event.state?.scrollY || 0,
        animate: !event.hasUAVisualTransition
      });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    writeSession(MOOD_DRAFT_KEY, mood);
  }, [mood]);

  // Picks the user has since completed or dropped on MyAnimeList don't need a
  // "did you watch it?" question; check the list in the background on open.
  useEffect(() => {
    if (!(tokens?.access_token || mode === "username") || !loadHistory().some(isAwaitingAnswer)) return;
    fetchOwnList()
      .then(applyListAnswers)
      .catch(() => {
        // Not worth an error here; the next request will surface it.
      });
  }, []);

  // The log on other devices: sync shortly after anything changes here, and
  // when the tab comes back into view (another device may have moved on).
  useEffect(() => {
    if (!syncSettings.enabled) return undefined;
    if (JSON.stringify(localSnapshot()) === lastSyncedSnapshot.current) return undefined;
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      if (JSON.stringify(localSnapshot()) !== lastSyncedSnapshot.current) runSync();
    }, 1500);
    return () => clearTimeout(syncTimer.current);
  }, [history, preferences, syncSettings.enabled]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && loadSyncSettings().enabled && Date.now() - lastSyncAt.current > 30000) {
        runSync();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Signing in with MyAnimeList on a new device: if the log was synced from
  // another one, pick it up. Checked once per device.
  useEffect(() => {
    const settings = loadSyncSettings();
    if (settings.enabled || settings.probed || mode !== "mal" || !tokens?.access_token) return;
    setSyncSettings(saveSyncSettings({ ...settings, probed: true }));
    withMalToken((token) => fetchRemoteSnapshot({ token }))
      .then((remote) => {
        if (!remote?.history?.length) return;
        enableSync({ via: "mal" });
        setNotice({ kind: "info", text: "Your log from your other devices is here." });
      })
      .catch(() => {
        // No stored copy, or no storage on this server: nothing to pick up.
      });
  }, [tokens?.access_token, mode]);

  // A room on screen (or a pick from one, just handed over) is checked every
  // few seconds while the tab is visible.
  const pollRoomId =
    view === VIEW.ROOM ? roomId : view === VIEW.REVEAL && revealEntry?.room_id && sessionEntryIds.current.has(revealEntry.id) ? revealEntry.room_id : null;
  useEffect(() => {
    if (!pollRoomId) return undefined;
    let stopped = false;
    let timer;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await refreshRoom(pollRoomId);
      if (!stopped) timer = setTimeout(tick, ROOM_POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pollRoomId]);

  // Past picks from before En kept what each pick was: look them up so they
  // teach it too. Quietly, at startup and when the taste page has the list.
  async function catchUpPastPicks(list = null) {
    if (catchUpRunning.current) return;
    const history = loadHistory();
    if (!history.some(needsBackfill) && !Array.isArray(list)) return;
    catchUpRunning.current = true;
    setCatchingUp(true);
    try {
      const patches = await backfillPastPicks({ history, list: Array.isArray(list) ? list : null });
      if (patches.size) setHistory(patchHistoryEntries(patches));
    } finally {
      catchUpRunning.current = false;
      setCatchingUp(false);
    }
  }

  useEffect(() => {
    if (!loadHistory().some(needsBackfill)) return undefined;
    const timer = setTimeout(() => catchUpPastPicks(), 2500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (view === VIEW.KNOWS && knows.status === "ready") catchUpPastPicks(knows.list);
  }, [view, knows.status]);

  // "What En knows about you" reads the list when it opens.
  useEffect(() => {
    if (view !== VIEW.KNOWS) return undefined;
    let cancelled = false;
    setKnows((current) => (current.status === "ready" ? current : { status: "loading", reload: current.reload }));
    fetchOwnList()
      .then((list) => !cancelled && setKnows({ status: "ready", list }))
      .catch((listError) =>
        !cancelled && setKnows({
          status: "error",
          error: isMalAuthError(listError) ? "Your MyAnimeList session expired. Connect again from the log." : listError.message
        })
      );
    return () => {
      cancelled = true;
    };
  }, [view, knows.reload]);

  useEffect(() => {
    if (view === VIEW.HISTORY && syncState.available === null) {
      syncAvailable().then((available) => setSyncState((current) => ({ ...current, available })));
    }
  }, [view]);

  useEffect(() => {
    if (window.location.pathname !== "/callback" || handledCallback.current) return;

    handledCallback.current = true;
    setStatus("Receiving the thread from MyAnimeList");
    finishMalOauth(window.location.href)
      .then((nextTokens) => {
        setTokens(nextTokens);
        chooseMode("mal");
        setStatus("");
        goHome({ replace: true });
      })
      .catch((oauthError) => {
        setStatus("");
        go(VIEW.LANDING, { replace: true });
        setError(oauthError.message);
      });
  }, []);

  // In-app navigation: one browser-history entry per screen.
  function go(nextView, { replace = false, entryId = null, titles, roomId = null } = {}) {
    setError("");
    if (nextView !== VIEW.THINKING) activeRequest.current += 1;
    const route = { view: nextView, entryId, titles, roomId };
    showRoute(route, writeHistory(replace ? "replace" : "push", route));
  }

  // Screen changes cross-fade where the browser supports it (the View
  // Transitions API), with the wordmark holding still. The new screen is
  // rendered synchronously inside the transition so it's captured complete.
  function showRoute({ view: nextView, entryId, titles, roomId: nextRoomId }, idx, { scrollY = 0, animate = true } = {}) {
    const apply = () => {
      if (entryId) setRevealEntryId(entryId);
      if (nextRoomId) setRoomId(nextRoomId);
      if (titles) setShortlistTitles(titles);
      setRouteIdx(idx);
      setView(nextView);
      arrival.current = { scrollY };
      setArrivals((count) => count + 1);
    };
    // After the first screen, entrances are quicker (see styles.css).
    document.documentElement.classList.add("en-settled");
    if (!animate || !canAnimateScreens()) {
      apply();
      return;
    }
    // The browser only swaps screens on its next frame; if it isn't drawing
    // (a covered window), don't leave the old screen up waiting for one.
    let applied = false;
    const run = () => {
      if (applied) return;
      applied = true;
      flushSync(apply);
    };
    const transition = document.startViewTransition(run);
    setTimeout(() => {
      if (applied) return;
      transition.skipTransition();
      run();
    }, 400);
  }

  // Arriving on a screen: the right scroll position (the top, or where you
  // were when you go back), and focus on its heading, so keyboard and
  // screen-reader users start at the new screen instead of a stale button.
  useLayoutEffect(() => {
    const landed = arrival.current;
    if (!landed) return;
    arrival.current = null;
    window.scrollTo(0, landed.scrollY);
    const heading = document.querySelector(".app-frame h1, .app-frame h2");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
  }, [arrivals]);

  // Home is tonight's mood question, after any "did you watch it?" questions
  // about earlier picks; the landing page until En has a list to read.
  function goHome(options) {
    if (!hasRecommendationInput()) {
      go(VIEW.LANDING, options);
      return;
    }

    const pendingIds = findReviewEntries(loadHistory(), sessionEntryIds.current).map((entry) => entry.id);
    setPendingReviewIds(pendingIds);
    go(pendingIds.length ? VIEW.PENDING : VIEW.MOOD, options);
  }

  // "← back" follows the browser's history when there is some in this tab,
  // otherwise goes up a level (e.g. a pick opened in a new tab -> the log).
  function goBack() {
    if ((window.history.state?.idx ?? 0) > 0) {
      window.history.back();
      return;
    }
    const parent = PARENT[view];
    if (parent === VIEW.MOOD) goHome({ replace: true });
    else if (parent) go(parent, { replace: true, entryId: revealEntryId });
  }

  async function handleConnect() {
    setError("");
    try {
      beginMalOauth();
    } catch (connectError) {
      setError(connectError.message);
    }
  }

  function handleManualStart() {
    setMode("manual");
    go(VIEW.MANUAL);
  }

  function handleManualSubmit(value) {
    const nextValue = value.trim();
    setManualList(nextValue);
    saveManualList(nextValue);
    chooseMode("manual");
    goHome();
  }

  function canAskEn() {
    if (mode === "username") return Boolean(loadListSource());
    return hasRecommendationInput() && (mode === "manual" || Boolean(tokens?.access_token));
  }

  function chooseMode(nextMode) {
    setMode(nextMode);
    saveActiveMode(nextMode);
  }

  // The user's own list, from wherever they chose: MAL login, a public
  // MAL/AniList username, or what they typed.
  async function fetchOwnList() {
    if (mode === "manual") return manualList;
    if (mode !== "username") return fetchAnimeListWithRefresh();

    const source = loadListSource();
    const key = `${source.kind}:${source.username}`;
    const cached = malListCache.current;
    if (cached && cached.token === key && Date.now() - cached.fetchedAt < MAL_LIST_TTL_MS) return cached.list;
    const list = await fetchPublicList(source);
    malListCache.current = { token: key, list, fetchedAt: Date.now() };
    return list;
  }

  // Reads the list once up front, so a typo'd username or a private list
  // is caught on this screen rather than after "thinking".
  async function handleUsernameSubmit({ kind, username }) {
    const source = { kind, username: username.trim() };
    if (!source.username) return;
    setError("");
    setCheckingUsername(true);
    try {
      const list = await fetchPublicList(source);
      if (!list.length) throw new Error(`${source.username}'s list is empty, so En has nothing to read.`);
      malListCache.current = { token: `${source.kind}:${source.username}`, list, fetchedAt: Date.now() };
    } catch (usernameError) {
      setCheckingUsername(false);
      setError(usernameError.message);
      return;
    }
    setCheckingUsername(false);
    saveListSource(source);
    chooseMode("username");
    goHome();
  }

  // Returns an id for the request; anything it does after an await checks
  // isCurrent(id) first, because the user may have navigated away meanwhile.
  function beginThinking(moodText, { replace = false } = {}) {
    passOverUnanswered();
    setStatus(mode === "manual" ? "Reading what you told En" : "Reading your history");
    setThinkingMood(moodText || "");
    setHeardMood("");
    go(VIEW.THINKING, { replace });
    activeRequest.current += 1;
    return activeRequest.current;
  }

  // Reads the mood (see moodReading.js) while the list loads, and says how
  // it was heard on the thinking screen as soon as that's back.
  function hearMood(requestId, moodText, { partnerMood = "" } = {}) {
    return readMood(moodText, { passedOver: passedOverTonight(), partnerMood }).then((reading) => {
      if (isCurrent(requestId) && reading?.reading) setHeardMood(reading.reading);
      return reading;
    });
  }

  function isCurrent(requestId) {
    return requestId === activeRequest.current;
  }

  // Asking for another pick means tonight's unanswered ones were passed over.
  // They're logged as "not tonight": no "did you watch it?" next visit, and
  // they can come back after a cooldown instead of being banned for good.
  // A pick marked "watch it tonight" is left alone.
  function passOverUnanswered() {
    const passed = loadHistory().filter((entry) =>
      sessionEntryIds.current.has(entry.id) && entry.state === "unrated" && !entry.watch_tonight
    );
    passed.forEach((entry) => answerEntry(entry, "not-tonight"));
  }

  function passedOverTonight() {
    return loadHistory()
      .filter((entry) => sessionEntryIds.current.has(entry.id) && entry.state === "not_tonight")
      .map((entry) => ({ title: entry.recommendation.title, reason: entry.pass_reason || "", episodes: entry.recommendation.episodes }));
  }

  // Records answers read off the user's MAL list (see answersFromList).
  function applyListAnswers(list) {
    const source = mode === "username" ? loadListSource() : null;
    const answers = answersFromList({ list, history: loadHistory(), sourceName: source ? sourceLabel(source) : "MyAnimeList" });
    if (!answers.length) return;
    const byId = new Map(loadHistory().map((entry) => [entry.id, entry]));
    for (const { id, answer, reflection, scoreDelta } of answers) {
      const entry = byId.get(id);
      if (entry) answerEntry(entry, answer, { reflection, scoreDelta, answeredFrom: source?.kind === "anilist" ? "anilist" : "myanimelist" });
    }
    debugLog("[En debug] answered from MyAnimeList", answers);

    // If the "did you watch it?" screen is up, skip what MAL just answered.
    if (viewRef.current === VIEW.PENDING) {
      const remaining = findReviewEntries(loadHistory(), sessionEntryIds.current).map((entry) => entry.id);
      setPendingReviewIds(remaining);
      if (!remaining.length) go(VIEW.MOOD, { replace: true });
    }
  }

  // Everything En knows about the user, gathered once per request. The log is
  // read from storage rather than state so an answer saved a moment ago (e.g.
  // "I've already seen it" right before asking again) is included.
  async function loadEnContext() {
    const list = await fetchOwnList();
    setMalList(Array.isArray(list) ? list : []);
    applyListAnswers(list);
    // How they scored answered picks on their own list sharpens what En learns.
    const deltas = scoreDeltas(loadHistory(), list);
    if (deltas.size) setHistory(patchHistoryEntries(new Map([...deltas].map(([id, delta]) => [id, { score_delta: delta }]))));
    const history = loadHistory();

    // The cache keeps what En inferred; the user's corrections are applied
    // on top each time, so undoing one brings the inference back.
    const inferredProfile = buildTasteProfile({
      malList: list,
      feedbackHistory: history,
      previousProfile: loadTasteProfileCache()
    });
    saveTasteProfileCache(inferredProfile);
    const preferences = loadPreferences();
    const tasteProfile = applyTasteCorrections(inferredProfile, preferences);
    const userSaid = userSaidFor(preferences);
    const tasteModel = buildTasteModel(history, { ignored: preferences.unlearned });
    const learned = learnedForModel(tasteModel, history);

    const memory = buildRecommendationMemory({
      malList: list,
      history,
      existingMemory: loadRecommendationMemoryCache()
    });
    saveRecommendationMemoryCache(memory);

    if (Array.isArray(list)) {
      debugLog("[En debug] MAL list item count", list.length);
      debugLog("[En debug] MAL status counts", countStatuses(list));
      debugLog("[En debug] persistent memory counts", countMemory(memory));
    }

    return {
      list,
      memory,
      tasteModel,
      unwatchedTitles: buildUnwatchedTitles({ malList: list, history }),
      signals: {
        watchHistory: buildWatchHistoryDigest(list),
        tasteProfile,
        recentPatterns: summarizeRecentPatterns(list, history),
        feedbackHistory: compactFeedbackHistory(history),
        ...(userSaid ? { userSaid } : {}),
        ...(learned ? { learned } : {})
      }
    };
  }

  // Candidates from all of AniList (see discovery.js), or the curated
  // catalog if AniList can't be reached.
  async function findCandidates({ mood, list, signals, memory, partner: other, includeResume = false, moodReading = null, alsoExcluded = [], tasteModel = null }) {
    const learned = learnedRanker(tasteModel);
    const passedOver = passedOverTonight();
    const { excludedGenres, mutedSeeds } = loadPreferences();
    const exclude = exclusionFilter([...new Set([...excludedGenres, ...alsoExcluded])]);
    const { candidates, source, constraints, constraintsRelaxed } = other
      ? await buildTogetherPool({
          mood,
          passedOver,
          you: { list, history: loadHistory(), memory, tasteProfile: signals.tasteProfile },
          partner: other,
          recentPatterns: signals.recentPatterns,
          exclude,
          mutedSeeds,
          moodReading,
          learned
        })
      : await buildOpenCandidatePool({
          mood,
          passedOver,
          list,
          history: loadHistory(),
          tasteProfile: signals.tasteProfile,
          recentPatterns: signals.recentPatterns,
          memory,
          includeResume,
          exclude,
          mutedSeeds,
          moodReading,
          learned
        });
    debugLog("[En debug] candidate pool", { source, count: candidates.length, constraints, constraintsRelaxed, leftOut: exclude.labels, moodReading });
    if (!candidates.length) {
      throw new Error(
        exclude.labels.length
          ? `Leaving out ${joinList(exclude.labels)} left En nothing to pick from. Let one back in and ask again.`
          : "En couldn't find anything left to pick tonight. Try again in a moment."
      );
    }
    // Only sent when there's something to say, to keep the payload lean.
    const steering = {
      ...(Object.keys(constraints || {}).length ? { constraints } : {}),
      ...(constraintsRelaxed ? { constraintsRelaxed: true } : {}),
      ...(passedOver.length ? { passedOverTonight: passedOver.map(({ title, reason }) => ({ title, reason: reason || "not feeling it" })) } : {})
    };
    return { candidates, steering };
  }

  async function describeQueriedTitles(titles, list) {
    const resolved = await Promise.all(titles.map((title) => resolveAnimeOnAniList(title)));
    return titles.map((asked, index) =>
      describeQueriedTitle({ asked, resolved: resolved[index], list, history: loadHistory() })
    );
  }

  // The pick is saved to the log the moment it's shown, so closing the tab
  // before rating it no longer loses the entry (while its title stays banned).
  // A pick for a request the user already walked away from is dropped unseen.
  function revealPick(requestId, pick, entryFields) {
    if (!isCurrent(requestId)) return;
    recordRecommendedAnime(pick, "recommended");
    const entry = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      recommendation: pick,
      note: "",
      feedback: "",
      state: "unrated",
      ...entryFields
    };
    sessionEntryIds.current.add(entry.id);
    setHistory(appendHistory(entry));
    setStatus("");
    go(VIEW.REVEAL, { replace: true, entryId: entry.id });
    return entry;
  }

  function handleRequestError(requestId, requestError) {
    if (!isCurrent(requestId)) return;
    setStatus("");

    if (isMalAuthError(requestError)) {
      clearExpiredMalSession();
      go(VIEW.LANDING, { replace: true });
      setError("Your MyAnimeList session expired. Please connect again.");
      return;
    }

    // Step back off the thinking screen to wherever the request started,
    // and keep the error showing there.
    if (window.history.state?.view === VIEW.THINKING && (window.history.state?.idx ?? 0) > 0) {
      setError(requestError.message);
      keepErrorOnPop.current = true;
      window.history.back();
    } else {
      goHome({ replace: true });
      setError(requestError.message);
    }
  }

  async function handleConsider(nextMood, { replace = false } = {}) {
    if (!canAskEn()) {
      go(VIEW.LANDING, { replace: true });
      return;
    }

    const requestId = beginThinking(nextMood, { replace });
    const say = (text) => isCurrent(requestId) && setStatus(text);
    const heard = hearMood(requestId, nextMood);
    try {
      const { list, signals, memory, unwatchedTitles, tasteModel } = await loadEnContext();
      say("Looking through everything you haven't seen");
      const { candidates: candidateList, steering } = await findCandidates({ mood: nextMood, list, signals, memory, includeResume: true, moodReading: await heard, tasteModel });
      say("Considering");

      const rec = await askForAllowedRecommendation({ mood: nextMood, signals: { ...signals, ...steering }, candidateList, memory, unwatchedTitles });
      const pick = await withImage(rec, [rec.title_jp]);
      revealPick(requestId, pick, {
        mood: nextMood || "Surprise me",
        request_mood: nextMood,
        ...(pick.resume ? { mode: "resume" } : {})
      });
    } catch (considerError) {
      handleRequestError(requestId, considerError);
    }
  }

  // ---------- For two ----------

  async function loadPartnerList(who) {
    if (who.kind === "manual") return who.list;
    const cached = partnerListCache.current;
    if (cached && cached.username === who.username && Date.now() - cached.fetchedAt < MAL_LIST_TTL_MS) {
      return cached.list;
    }
    const list = await fetchPartnerList(who.username);
    partnerListCache.current = { username: who.username, list, fetchedAt: Date.now() };
    return list;
  }

  // Reads their list once up front, so a typo'd username or a private list
  // is caught on this screen rather than after "thinking".
  async function handlePartnerSubmit(draft) {
    const next = draft.kind === "mal"
      ? { kind: "mal", username: draft.username.trim() }
      : { kind: "manual", name: draft.name.trim(), list: draft.list.trim() };
    if (next.kind === "mal" ? !next.username : !next.list) return;

    setError("");
    if (next.kind === "mal") {
      setCheckingPartner(true);
      try {
        const list = await loadPartnerList(next);
        if (!list.length) throw new Error(`${next.username}'s list is empty, so En has nothing to read.`);
      } catch (partnerError) {
        setCheckingPartner(false);
        setError(partnerError.message);
        return;
      }
      setCheckingPartner(false);
    }
    savePartner(next);
    setPartner(next);
    go(VIEW.TOGETHER_MOOD);
  }

  async function handleTogether(moodText, { replace = false } = {}) {
    const who = loadPartner();
    if (!who) {
      go(VIEW.TOGETHER, { replace: true });
      return;
    }
    if (!canAskEn()) {
      go(VIEW.LANDING, { replace: true });
      return;
    }

    const name = partnerName(who);
    const requestId = beginThinking(moodText, { replace });
    const say = (text) => isCurrent(requestId) && setStatus(text);
    const heard = hearMood(requestId, moodText);
    try {
      const { list, signals, memory, unwatchedTitles, tasteModel } = await loadEnContext();
      say(`Reading ${possessive(name)} list`);
      const partnerList = await loadPartnerList(who);
      const partnerTaste = buildTasteProfile({ malList: partnerList, feedbackHistory: [] });
      say("Looking for something you'd both like");
      const { candidates: candidateList, steering } = await findCandidates({
        mood: moodText,
        list,
        signals,
        memory,
        partner: { list: partnerList, tasteProfile: partnerTaste },
        moodReading: await heard,
        tasteModel
      });
      say("Considering");

      const rec = await askForAllowedRecommendation({
        mood: moodText,
        signals: {
          ...signals,
          ...steering,
          partner: { name: name === "them" ? "" : name, watchHistory: buildWatchHistoryDigest(partnerList), tasteProfile: partnerTaste }
        },
        candidateList,
        memory,
        unwatchedTitles,
        ask: askEnTogether,
        label: "together"
      });
      const pick = await withImage({ ...rec, mode: "together", partner_name: name }, [rec.title_jp]);
      revealPick(requestId, pick, {
        mood: moodText || `for two, with ${name}`,
        request_mood: moodText,
        mode: "together",
        partner_name: name
      });
    } catch (togetherError) {
      handleRequestError(requestId, togetherError);
    }
  }

  function handleShortlistStart() {
    go(VIEW.SHORTLIST);
  }

  function handleShortlistSubmit(rawText) {
    const text = rawText.trim();
    if (!text) return;

    const titles = splitShortlist(text);
    if (!titles.length) return;

    setChooseMood("");
    go(VIEW.SHORTLIST_MOOD, { titles });
  }

  function handleShortlistDecide(titles, moodText) {
    if (titles.length <= 1) {
      handleVerdict(titles[0] || "", moodText);
    } else {
      handleChoose(titles, moodText);
    }
  }

  async function handleChoose(titles, moodText) {
    if (!titles.length || !canAskEn()) {
      go(VIEW.LANDING, { replace: true });
      return;
    }

    const requestId = beginThinking(moodText);
    const say = (text) => isCurrent(requestId) && setStatus(text);
    try {
      const { list, signals } = await loadEnContext();
      say("Weighing them against each other");
      const queriedTitleHistory = await describeQueriedTitles(titles, list);

      const choice = await askForAllowedChoice({
        queriedTitles: titles,
        queriedTitleHistory,
        mood: moodText,
        signals
      });

      // Compare against what the user typed, not the canonical title AniList
      // returns - "frieren" never equals "Frieren: Beyond Journey's End".
      const chosenIndex = Math.max(0, findQueriedIndex(choice, titles));
      const resolvedMeta = await resolveAnimeMetadata(titles[chosenIndex], choice.title);
      const pick = await withImage(
        {
          ...applyResolvedMeta(choice, resolvedMeta),
          mode: "choose",
          chooseAgainst: titles.filter((_, index) => index !== chosenIndex)
        },
        [choice.title_jp]
      );

      revealPick(requestId, pick, {
        mood: moodText || `choosing between ${titles.join(", ")}`,
        mode: "choose",
        queried_title: titles.join(" vs "),
        verdict: "yes"
      });
    } catch (chooseError) {
      handleRequestError(requestId, chooseError);
    }
  }

  async function handleVerdict(rawText, moodText = "") {
    const text = rawText.trim();
    if (!text || !canAskEn()) {
      go(VIEW.LANDING, { replace: true });
      return;
    }

    const requestId = beginThinking(moodText);
    const say = (status) => isCurrent(requestId) && setStatus(status);
    const heard = hearMood(requestId, moodText);
    try {
      const { list, memory, signals, tasteModel } = await loadEnContext();
      say("Weighing it against your history");
      const queriedTitles = [text];
      const [queriedTitleHistory, { candidates: candidateList, steering }] = await Promise.all([
        describeQueriedTitles(queriedTitles, list),
        heard.then((moodReading) => findCandidates({ mood: moodText, list, signals, memory, moodReading, tasteModel }))
      ]);

      const verdict = await askForAllowedVerdict({
        queriedTitles,
        queriedTitleHistory,
        mood: moodText,
        signals: { ...signals, ...steering },
        candidateList,
        memory
      });

      // A "yes" must show the title the user actually asked about, whatever
      // canonical name the model gave it. A "no" alternative from the open
      // pool already carries AniList metadata and a cover.
      const resolvedMeta = verdict.verdict === "yes"
        ? await resolveAnimeMetadata(text, verdict.title)
        : verdict.anilistId
          ? null
          : await resolveAnimeMetadata(verdict.title, verdict.title_jp);
      const pick = await withImage(applyResolvedMeta(verdict, resolvedMeta), [verdict.title_jp]);

      revealPick(requestId, pick, {
        mood: moodText || `asked about ${verdict.queried_title}`,
        mode: "verdict",
        queried_title: verdict.queried_title,
        verdict: verdict.verdict
      });
    } catch (verdictError) {
      handleRequestError(requestId, verdictError);
    }
  }

  async function fetchAnimeListWithRefresh() {
    const cached = malListCache.current;
    if (cached && cached.token === tokens.access_token && Date.now() - cached.fetchedAt < MAL_LIST_TTL_MS) {
      return cached.list;
    }

    const remember = (token, list) => {
      malListCache.current = { token, list, fetchedAt: Date.now() };
      return list;
    };

    try {
      return remember(tokens.access_token, await fetchAnimeList(tokens.access_token));
    } catch (listError) {
      if (!isMalAuthError(listError)) {
        throw listError;
      }

      try {
        setStatus("Refreshing MyAnimeList connection");
        const nextTokens = await refreshMalOauth(tokens);
        setTokens(nextTokens);
        return remember(nextTokens.access_token, await fetchAnimeList(nextTokens.access_token));
      } catch (refreshError) {
        throw isMalAuthError(refreshError)
          ? refreshError
          : new MalAuthError("Your MyAnimeList session expired. Please connect again.");
      }
    }
  }

  function clearExpiredMalSession() {
    clearTokens();
    setTokens(null);
    setMode(loadListSource() ? "username" : manualList.trim() ? "manual" : "mal");
    setMalList([]);
    malListCache.current = null;
  }

  // Applies a "how was it?" answer to a logged pick: from the return-visit
  // question, the log, or a reopened pick.
  // "Watching it" and "I'll watch it later" snooze the question (see
  // reviewQueue.js); saving a pick straight from the reveal doesn't, so it's
  // still asked about on the next visit.
  function answerEntry(entry, answer, { note = "", seenBefore = false, reflection = "", reason = "", answeredFrom = "myanimelist", snooze = true, scoreDelta = null } = {}) {
    let patch;
    if (answer === "watching") {
      patch = {
        feedback: "",
        feedback_note: "",
        state: "watching",
        watching_since: entry.watching_since || new Date().toISOString(),
        note: "watching it.",
        ask_after: askAgainAfter("watching")
      };
    } else if (answer === "not-tonight") {
      patch = {
        feedback: "",
        feedback_note: "",
        state: "not_tonight",
        not_tonight_at: new Date().toISOString(),
        pass_reason: reason,
        note: reason ? `not tonight · ${reason}.` : "not tonight."
      };
    } else if (answer === "later") {
      patch = { feedback: "", feedback_note: "", state: "pending", note: "waiting in the watchlist", ask_after: snooze ? askAgainAfter("later") : null };
    } else if (answer === "pass") {
      patch = { feedback: "", feedback_note: "", state: "skipped", note: "passed on it.", ask_after: null };
    } else {
      patch = {
        feedback: answer,
        state: "rated",
        feedback_note: note.trim(),
        note: reflection || makeUserReflection(answer, note),
        ask_after: null,
        ...(Number.isFinite(scoreDelta) ? { score_delta: scoreDelta } : {}),
        ...(reflection ? { answered_from: answeredFrom } : {}),
        ...(seenBefore ? { seen_before: true } : {})
      };
    }

    const nextHistory = updateHistoryEntry(entry.id, patch);
    if (answer === "later") {
      recordRecommendedAnime(entry.recommendation, "pending");
      recordRecommendedAnime(entry.recommendation, "watchlisted");
    } else if (answer === "good") {
      recordRecommendedAnime(entry.recommendation, "completed");
    } else if (answer === "meh") {
      recordRecommendedAnime(entry.recommendation, "rejected");
    }
    setHistory(nextHistory);
    // Answers read off the list itself don't need writing back to it.
    if (!reflection && MAL_ACTION_FOR[answer]) shareWithMal(entry, MAL_ACTION_FOR[answer]);
    return nextHistory;
  }

  function handleSaveForLater() {
    if (revealEntry) answerEntry(revealEntry, "later", { snooze: false });
  }

  // "I've already seen it": keep how it landed as a taste signal, then ask
  // again with the mood that produced this pick (the title is already banned).
  function handleWatchTonight() {
    if (!revealEntry) return;
    setHistory(updateHistoryEntry(revealEntry.id, { watch_tonight: true }));
    shareWithMal(revealEntry, "tonight");
  }

  // "Not tonight": log why, then ask again with the same mood. The reason
  // steers the next pick ("too long" -> shorter, "too heavy" -> lighter).
  function handleNotTonight(reason) {
    if (!revealEntry) return;
    answerEntry(revealEntry, "not-tonight", { reason });
    if (revealEntry.room_id) {
      const local = loadRoom(revealEntry.room_id);
      if (local?.role === "guest") {
        // The choosing happens on their phone: tell it, and wait for the next one.
        updateRoom(revealEntry.room_id, { action: "pass", key: local.key, pass: { pickId: revealEntry.room_pick_id, reason } })
          .catch((roomError) => setError(roomError.message));
        go(VIEW.ROOM, { replace: true, roomId: revealEntry.room_id });
      } else {
        handleRoomPick(revealEntry.room_id, { replace: true });
      }
      return;
    }
    if (revealEntry.mode === "together") handleTogether(revealEntry.request_mood ?? "", { replace: true });
    else handleConsider(revealEntry.request_mood ?? "", { replace: true });
  }

  function handleSeenFeedback(feedback, feedbackNote = "") {
    if (!revealEntry) return;
    answerEntry(revealEntry, feedback, { note: feedbackNote, seenBefore: true });
    handleConsider(revealEntry.request_mood ?? "", { replace: true });
  }

  function handleAnswer(id, answer) {
    const entry = history.find((item) => item.id === id);
    if (entry) answerEntry(entry, answer);
  }

  function handlePendingAnswer(answer) {
    const reviewIds = pendingReviewIds.length
      ? pendingReviewIds
      : findReviewEntries(history, sessionEntryIds.current).map((entry) => entry.id);
    const pending = findCurrentPending(history, reviewIds, sessionEntryIds.current);
    if (!pending) {
      setPendingReviewIds([]);
      go(VIEW.MOOD, { replace: true });
      return;
    }

    // Answered questions are replaced rather than stacked, so "back" from the
    // mood screen doesn't walk back through them.
    const nextHistory = answerEntry(pending, answer);
    const due = new Set(findReviewEntries(nextHistory, sessionEntryIds.current).map((entry) => entry.id));
    const nextPendingIds = reviewIds.filter((id) => id !== pending.id && due.has(id));
    setPendingReviewIds(nextPendingIds);
    go(nextPendingIds.length ? VIEW.PENDING : VIEW.MOOD, { replace: true });
  }

  function handleDeleteHistoryEntry(id) {
    const nextHistory = deleteHistoryEntry(id);
    setHistory(nextHistory);
    setPendingReviewIds((ids) => ids.filter((pendingId) => pendingId !== id));
  }

  function handleClearHistory() {
    if (history.length && !window.confirm("Clear the log? En will also forget what it has recommended, so those titles can come up again.")) {
      return;
    }

    const nextHistory = clearRecommendationLog();
    setHistory(nextHistory);
    setPendingReviewIds([]);
  }

  function handleDisconnect() {
    if (!window.confirm("Disconnect MyAnimeList? Your log stays on this device.")) {
      return;
    }

    clearTokens();
    setTokens(null);
    setMalList([]);
    malListCache.current = null;
    go(VIEW.LANDING);
  }

  // ---------- For two, from two phones ----------
  // One phone (the host's) makes a link and does the choosing; the other
  // joins with its own list and mood. Both poll the room (api/room.js) while
  // it's on screen: the host to start once the other person is in and to
  // re-pick when they pass, the guest to show each pick as it arrives.

  async function handleCreateRoom(name) {
    setError("");
    saveMyName(name);
    try {
      const { id, hostKey } = await createRoom({ hostName: name.trim() });
      saveRoom(id, { role: "host", key: hostKey, hostName: name.trim() });
      setRoom({ status: "idle" });
      go(VIEW.ROOM, { roomId: id });
    } catch (roomError) {
      setError(roomError.code === "not_configured" ? "Picking from two phones needs En's storage, which isn't set up here." : roomError.message);
    }
  }

  async function refreshRoom(id) {
    const local = loadRoom(id);
    try {
      const data = await fetchRoom(id, local?.role === "host" ? { hostKey: local.key } : {});
      setRoom({ status: "ready", id, data });
      reactToRoom(id, data);
    } catch (roomError) {
      setRoom({ status: roomError.code === "gone" ? "gone" : "error", id, error: roomError.message });
    }
  }

  function reactToRoom(id, data) {
    const local = loadRoom(id);
    if (!local) return;
    const latest = data.picks.at(-1);
    if (local.role === "host") {
      if (!latest && local.ready && data.guest && !roomBusy.current && viewRef.current === VIEW.ROOM) {
        handleRoomPick(id);
        return;
      }
      // They passed on the pick that's showing: pick again, for both.
      const pass = latest && data.passes.find((item) => item.pickId === latest.id && !local.handledPasses.includes(item.pickId));
      if (pass && !roomBusy.current) {
        saveRoom(id, { handledPasses: [...local.handledPasses, pass.pickId] });
        const shown = loadHistory().find((entry) => entry.id === latest.id);
        if (shown?.state === "unrated") answerEntry(shown, "not-tonight", { reason: pass.reason });
        setNotice({
          kind: "info",
          text: `${data.guest?.name || "They"} passed on ${latest.recommendation.title}${pass.reason ? ` (${pass.reason})` : ""}. Finding another.`
        });
        handleRoomPick(id, { replace: viewRef.current === VIEW.REVEAL });
      }
      return;
    }
    if (latest && !local.seenPickIds.includes(latest.id)) receiveRoomPick(id, data, latest, local);
  }

  // The host's phone picks, from both lists and both moods, and posts it.
  async function handleRoomPick(id, { replace = false } = {}) {
    const local = loadRoom(id);
    if (!local?.key || roomBusy.current) return;
    roomBusy.current = true;
    const requestId = beginThinking(local.hostMood || "", { replace });
    const say = (text) => isCurrent(requestId) && setStatus(text);
    try {
      const data = await fetchRoom(id, { hostKey: local.key });
      if (!data.guest?.list) throw new Error("They haven't joined yet.");
      const guest = data.guest;
      const name = guest.name || "them";
      const heard = hearMood(requestId, local.hostMood || guest.mood, { partnerMood: local.hostMood ? guest.mood : "" });
      const { list, signals, memory, unwatchedTitles, tasteModel } = await loadEnContext();
      say(`Reading ${possessive(name)} list`);
      const partnerList = partnerListFromRoom(guest);
      const partnerTaste = buildTasteProfile({ malList: partnerList, feedbackHistory: [] });
      say("Looking for something you'd both like");
      const { candidates: candidateList, steering } = await findCandidates({
        mood: [local.hostMood, guest.mood].filter(Boolean).join(" "),
        list,
        signals,
        memory,
        partner: { list: partnerList, tasteProfile: partnerTaste },
        moodReading: await heard,
        alsoExcluded: guest.excludedGenres || [],
        tasteModel
      });
      say("Considering");

      const rec = await askForAllowedRecommendation({
        mood: local.hostMood || "",
        signals: {
          ...signals,
          ...steering,
          partner: {
            name: name === "them" ? "" : name,
            ...(guest.mood ? { mood: guest.mood } : {}),
            watchHistory: buildWatchHistoryDigest(partnerList),
            tasteProfile: partnerTaste
          },
          userName: local.hostName || "",
          bothPerspectives: true
        },
        candidateList,
        memory,
        unwatchedTitles,
        ask: askEnTogether,
        label: "together"
      });
      const pick = await withImage({ ...rec, mode: "together", partner_name: name }, [rec.title_jp]);
      const entry = revealPick(requestId, pick, {
        mood: `for two, with ${name}`,
        request_mood: local.hostMood || "",
        mode: "together",
        partner_name: name,
        room_id: id
      });
      // The host's own log entry id doubles as the pick's id in the room.
      if (entry) await updateRoom(id, { action: "pick", key: local.key, pick: { id: entry.id, recommendation: pick } });
    } catch (roomError) {
      handleRequestError(requestId, roomError);
    } finally {
      roomBusy.current = false;
    }
  }

  async function handleRoomReady(id, mood) {
    const local = saveRoom(id, { hostMood: mood.trim(), ready: true });
    try {
      await updateRoom(id, { action: "host", key: local.key, hostMood: mood.trim() });
    } catch {
      // Their phone just won't show your mood; the pick doesn't need it there.
    }
    refreshRoom(id);
  }

  // The other person's side: their own list (however they keep it) and mood.
  async function handleJoinRoom(id, { name, mood, source }) {
    setError("");
    setJoiningRoom(true);
    try {
      const list =
        source.kind === "own"
          ? await fetchOwnList()
          : source.kind === "typed"
            ? source.list.trim()
            : await fetchPublicList({ kind: source.kind, username: source.username.trim() });
      if (Array.isArray(list) ? !list.length : !String(list).trim()) {
        throw new Error("That list is empty, so En has nothing to read.");
      }
      const local = loadRoom(id)?.key ? loadRoom(id) : saveRoom(id, { role: "guest", key: newRoomKey() });
      const seenTitles = loadHistory()
        .filter((entry) => entry.feedback === "good" || entry.feedback === "meh")
        .map((entry) => entry.recommendation.title)
        .slice(0, 200);
      await updateRoom(id, {
        action: "join",
        key: local.key,
        name: name.trim(),
        mood: mood.trim(),
        list: trimListForRoom(list),
        seenTitles,
        excludedGenres: loadPreferences().excludedGenres
      });
      saveMyName(name);
      saveRoom(id, { role: "guest", guestName: name.trim(), guestMood: mood.trim(), joined: true });
      // Someone new to En keeps the list they just used, for next time.
      if (!hasRecommendationInput()) {
        if (source.kind === "typed") {
          saveManualList(list);
          setManualList(list);
          chooseMode("manual");
        } else if (source.kind === "mal" || source.kind === "anilist") {
          saveListSource({ kind: source.kind, username: source.username.trim() });
          chooseMode("username");
        }
      }
      await refreshRoom(id);
    } catch (roomError) {
      setError(roomError.message);
    } finally {
      setJoiningRoom(false);
    }
  }

  // A pick arrived from the host's phone: into this person's own log, with
  // the reason written to them.
  function receiveRoomPick(id, data, latest, local) {
    saveRoom(id, { seenPickIds: [...local.seenPickIds, latest.id] });
    const previous = loadHistory().find((entry) => entry.room_id === id && entry.state === "unrated" && sessionEntryIds.current.has(entry.id));
    if (previous) answerEntry(previous, "not-tonight");
    const host = data.hostName || "them";
    const { reason_for_them: reasonForThem, log_line_for_them: lineForThem, ...rec } = latest.recommendation;
    const pick = { ...rec, reason: reasonForThem || rec.reason, log_line: lineForThem || rec.log_line, mode: "together", partner_name: host };
    recordRecommendedAnime(pick, "recommended");
    const entry = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      recommendation: pick,
      note: "",
      feedback: "",
      state: "unrated",
      mood: `for two, with ${host}`,
      request_mood: local.guestMood || "",
      mode: "together",
      partner_name: host,
      room_id: id,
      room_pick_id: latest.id
    };
    sessionEntryIds.current.add(entry.id);
    setHistory(appendHistory(entry));
    go(VIEW.REVEAL, { replace: viewRef.current === VIEW.REVEAL, entryId: entry.id });
  }

  // ---------- preferences ----------

  function changePreferences(patch) {
    setPreferences(updatePreferences(patch));
  }

  function toggleExcludedGenre(label) {
    const current = loadPreferences().excludedGenres;
    changePreferences({
      excludedGenres: current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
    });
  }

  // ---------- MyAnimeList, both ways ----------

  // Runs a MAL call with the current token, refreshing it once if it expired.
  async function withMalToken(call) {
    const current = loadTokens();
    if (!current?.access_token) throw new MalAuthError("Connect MyAnimeList first.");
    try {
      return await call(current.access_token);
    } catch (callError) {
      if (!isMalAuthError(callError)) throw callError;
      const next = await refreshMalOauth(current);
      setTokens(next);
      return call(next.access_token);
    }
  }

  // What the user tells En about a pick goes on their MAL list too, once
  // they've said yes to that (asked the first time it would happen).
  function shareWithMal(entry, action) {
    if (mode !== "mal" || !loadTokens()?.access_token || !entry?.recommendation) return;
    const setting = loadPreferences().malSync;
    if (setting === "off") return;
    if (setting !== "on") {
      setNotice((current) =>
        current?.kind === "mal-offer"
          ? { ...current, items: [...current.items, { entry, action }] }
          : { kind: "mal-offer", items: [{ entry, action }] }
      );
      return;
    }
    sendToMal(entry, action);
  }

  // Says what happened every time, including when nothing needed changing,
  // so a list that didn't move never looks like a failure.
  async function sendToMal(entry, action) {
    const title = entry.recommendation.title;
    try {
      const malId = await malIdFor(entry);
      if (!malId) {
        setNotice({ kind: "info", text: `En couldn't find ${title} on MyAnimeList, so your list wasn't changed.` });
        return;
      }
      const result = await withMalToken((token) => updateMalListStatus(token, malId, action));
      setNotice({
        kind: "info",
        text: result.changed
          ? `${title}: ${MAL_STATUS_WORDS[result.status] || "updated"} on your MyAnimeList.`
          : `Your MyAnimeList already has ${title} as ${MAL_STATUS_NAMES[result.status] || result.status}, so En left it.`
      });
    } catch (malError) {
      setNotice({
        kind: "info",
        text: isMalAuthError(malError) ? "MyAnimeList needs you to connect again before En can update your list." : malError.message
      });
    }
  }

  // Picks from before En kept MAL ids, and ones from the curated catalog,
  // don't have one: find it on the user's own list, else on AniList, and
  // keep it on the pick for next time.
  async function malIdFor(entry) {
    const rec = entry.recommendation;
    if (rec.malId) return rec.malId;
    const keys = new Set(animeTitleKeys(rec));
    const listed = Array.isArray(malListCache.current?.list) ? malListCache.current.list : [];
    const onList = listed.find((item) => item.id && animeTitleKeys(item).some((key) => keys.has(key)));
    let malId = onList?.id || null;
    let anilistId = rec.anilistId || null;
    if (!malId) {
      const resolved = (await resolveAnimeOnAniList(rec.title)) || (rec.title_jp && rec.title_jp !== rec.title ? await resolveAnimeOnAniList(rec.title_jp) : null);
      malId = resolved?.malId || null;
      anilistId ||= resolved?.anilistId || null;
    }
    const current = malId && loadHistory().find((item) => item.id === entry.id);
    if (current) {
      setHistory(updateHistoryEntry(entry.id, { recommendation: { ...current.recommendation, malId, ...(anilistId ? { anilistId } : {}) } }));
    }
    return malId;
  }

  function answerMalOffer(yes) {
    const items = notice?.kind === "mal-offer" ? notice.items : [];
    changePreferences({ malSync: yes ? "on" : "off" });
    setNotice(yes ? null : { kind: "info", text: "Okay. You can turn it on from the log." });
    if (yes) items.forEach(({ entry, action }) => sendToMal(entry, action));
  }

  // ---------- the log on other devices ----------

  function withSyncCredentials(settings, call) {
    if (settings.via === "code") return call({ code: settings.code });
    return withMalToken((token) => call({ token }));
  }

  function canSync(settings) {
    if (!settings.enabled) return false;
    return settings.via === "code" ? Boolean(settings.code) : Boolean(loadTokens()?.access_token);
  }

  // Sends this device's log and takes back the merged one. One at a time;
  // a change made meanwhile gets its own sync straight after.
  async function runSync() {
    const settings = loadSyncSettings();
    if (!canSync(settings)) return;
    if (syncing.current) {
      syncAgain.current = true;
      return;
    }
    syncing.current = true;
    setSyncState((current) => ({ ...current, busy: true }));
    try {
      const merged = await withSyncCredentials(settings, pushSnapshot);
      if (applyRemoteSnapshot(merged)) {
        setHistory(loadHistory());
        setPreferences(loadPreferences());
      }
      lastSyncedSnapshot.current = JSON.stringify(normalizeSnapshot(merged));
      lastSyncAt.current = Date.now();
      setSyncSettings(saveSyncSettings({ ...loadSyncSettings(), lastSyncedAt: new Date().toISOString() }));
      setSyncState((current) => ({ ...current, busy: false, error: "" }));
    } catch (syncError) {
      setSyncState((current) => ({
        ...current,
        busy: false,
        error: isMalAuthError(syncError) ? "Connect MyAnimeList again to keep syncing." : syncError.message
      }));
    } finally {
      syncing.current = false;
      if (syncAgain.current) {
        syncAgain.current = false;
        runSync();
      }
    }
  }

  function enableSync(settings) {
    lastSyncedSnapshot.current = "";
    setSyncSettings(saveSyncSettings({ ...loadSyncSettings(), ...settings, enabled: true, probed: true }));
    setSyncState((current) => ({ ...current, error: "" }));
    runSync();
  }

  // Joining with a code typed in from another device, or starting fresh:
  // MAL users sync by account, everyone else gets a code.
  function handleSyncOn(typedCode) {
    if (typedCode !== undefined) {
      const code = normalizeSyncCode(typedCode);
      if (!code) {
        setSyncState((current) => ({ ...current, error: "That isn't a code En made. It's 20 letters and numbers." }));
        return false;
      }
      enableSync({ via: "code", code });
      return true;
    }
    if (mode === "mal" && loadTokens()?.access_token) enableSync({ via: "mal", code: undefined });
    else enableSync({ via: "code", code: generateSyncCode() });
    return true;
  }

  async function handleSyncOff({ forget = false } = {}) {
    const settings = loadSyncSettings();
    if (forget) {
      try {
        await withSyncCredentials(settings, deleteRemoteSnapshot);
      } catch (syncError) {
        setSyncState((current) => ({ ...current, error: syncError.message }));
        return;
      }
    }
    setSyncSettings(saveSyncSettings({ probed: true }));
    setSyncState((current) => ({ ...current, error: "" }));
    setNotice({ kind: "info", text: forget ? "Syncing is off, and En's copy is gone. This device keeps its log." : "Syncing is off on this device." });
  }

  function handleExportLog() {
    const url = URL.createObjectURL(exportLogBlob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `en-log-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function handleImportLog(file) {
    try {
      const added = importLogText(await file.text());
      setHistory(loadHistory());
      setPreferences(loadPreferences());
      setNotice({
        kind: "info",
        text: added ? `Added ${added} pick${added === 1 ? "" : "s"} from the file.` : "Nothing new in that file. The log already had all of it."
      });
    } catch (importError) {
      setNotice({ kind: "info", text: importError.message });
    }
  }

  async function handleShare(entry) {
    try {
      return await sharePick(entry);
    } catch (shareError) {
      console.warn("[En] share card failed", shareError);
      setNotice({ kind: "info", text: "En couldn't make the card. Try again." });
      return "error";
    }
  }

  const nav = {
    back: goBack,
    canGoBack: routeIdx > 0 || Boolean(PARENT[view]),
    home: () => {
      if (view !== VIEW.MOOD) goHome();
    },
    goto: (nextView) => go(nextView),
    log: () => go(VIEW.HISTORY),
    newRecommendation: () => goHome(),
    connect: handleConnect,
    manualStart: handleManualStart,
    editManualList: () => go(VIEW.MANUAL),
    manualSubmit: handleManualSubmit,
    consider: handleConsider,
    shortlistStart: handleShortlistStart,
    togetherStart: () => go(VIEW.TOGETHER),
    usernameStart: () => go(VIEW.USERNAME),
    shortlistSubmit: handleShortlistSubmit,
    shortlistDecide: handleShortlistDecide,
    saveForLater: handleSaveForLater,
    seenIt: () => revealEntry && go(VIEW.FEEDBACK, { entryId: revealEntry.id }),
    seenFeedback: handleSeenFeedback,
    watchTonight: handleWatchTonight,
    notTonight: handleNotTonight,
    pendingAnswer: handlePendingAnswer,
    answer: handleAnswer,
    openPick: (id) => go(VIEW.REVEAL, { entryId: id }),
    deleteHistoryEntry: handleDeleteHistoryEntry,
    clearHistory: handleClearHistory,
    disconnect: handleDisconnect,
    knows: () => go(VIEW.KNOWS),
    createRoom: handleCreateRoom,
    roomReady: handleRoomReady,
    joinRoom: handleJoinRoom,
    share: handleShare,
    toggleMalSync: () => changePreferences({ malSync: loadPreferences().malSync === "on" ? "off" : "on" }),
    syncOn: handleSyncOn,
    syncOff: handleSyncOff,
    syncNow: runSync,
    exportLog: handleExportLog,
    importLog: handleImportLog
  };

  // A pick handed over in this visit and not yet answered gets the "watch it
  // tonight" actions; a reopened older pick shows how it went instead.
  const isNewPick = Boolean(revealEntry) && sessionEntryIds.current.has(revealEntry.id) && revealEntry.state === "unrated";
  // "I've already seen it" only makes sense when En chose the title; in
  // verdict/choose mode the user named it themselves.
  const canMarkSeen = isNewPick && !revealEntry.mode;
  // "Not tonight" re-asks the same question, which works for En's own picks
  // and for picks for two.
  const canPassTonight = isNewPick && (!revealEntry.mode || revealEntry.mode === "together" || revealEntry.mode === "resume");

  return (
    <NavContext.Provider value={nav}>
      <div style={{ minHeight: "100vh", position: "relative" }}>
        {error ? <ErrorRibbon message={error} onDismiss={() => setError("")} /> : null}
        <Notice notice={notice} onDismiss={() => setNotice(null)} onMalOffer={answerMalOffer} />
        {view === VIEW.LANDING && <ScreenLanding nav={nav} status={status} />}
        {view === VIEW.MANUAL && (
          <ScreenManual
            onLog={nav.log}
            onSubmit={handleManualSubmit}
            manualList={manualList}
            setManualList={setManualList}
          />
        )}
        {view === VIEW.PENDING && (
          <ScreenPending
            key={findCurrentPending(history, pendingReviewIds, sessionEntryIds.current)?.id}
            nav={nav}
            pending={findCurrentPending(history, pendingReviewIds, sessionEntryIds.current)}
          />
        )}
        {view === VIEW.MOOD && (
          <ScreenMood
            onLog={nav.log}
            onConsider={() => handleConsider(mood)}
            onSurprise={() => handleConsider("")}
            onShortlist={nav.shortlistStart}
            onTogether={nav.togetherStart}
            mood={mood}
            setMood={setMood}
            excluded={preferences.excludedGenres}
            onToggleGenre={toggleExcludedGenre}
            onClearGenres={() => changePreferences({ excludedGenres: [] })}
          />
        )}
        {view === VIEW.SHORTLIST && (
          <ScreenShortlist
            onLog={nav.log}
            onSubmit={nav.shortlistSubmit}
            shortlist={shortlist}
            setShortlist={setShortlist}
          />
        )}
        {view === VIEW.SHORTLIST_MOOD && (
          <ScreenShortlistMood
            onLog={nav.log}
            titles={shortlistTitles}
            mood={chooseMood}
            setMood={setChooseMood}
            onSubmit={() => nav.shortlistDecide(shortlistTitles, chooseMood)}
            onSkip={() => nav.shortlistDecide(shortlistTitles, "")}
          />
        )}
        {view === VIEW.USERNAME && (
          <ScreenUsername
            onLog={nav.log}
            source={loadListSource()}
            checking={checkingUsername}
            onSubmit={handleUsernameSubmit}
          />
        )}
        {view === VIEW.TOGETHER && (
          <ScreenTogether
            key={partner ? partnerName(partner) : "new"}
            onLog={nav.log}
            partner={partner}
            checking={checkingPartner}
            onSubmit={handlePartnerSubmit}
            onCreateRoom={handleCreateRoom}
            myName={loadMyName() || loadListSource()?.username || ""}
          />
        )}
        {view === VIEW.ROOM && roomId && (
          <ScreenRoom
            key={roomId}
            nav={nav}
            roomId={roomId}
            room={room.id === roomId ? room : { status: "loading" }}
            local={loadRoom(roomId)}
            history={history}
            joining={joiningRoom}
            ownList={hasRecommendationInput() ? (mode === "username" ? sourceLabel(loadListSource()) : mode === "manual" ? "typed" : "MyAnimeList") : ""}
            myName={loadMyName() || loadListSource()?.username || ""}
          />
        )}
        {view === VIEW.TOGETHER_MOOD && partner && (
          <ScreenTogetherMood
            onLog={nav.log}
            name={partnerName(partner)}
            mood={togetherMood}
            setMood={setTogetherMood}
            onSubmit={() => handleTogether(togetherMood)}
            onSurprise={() => handleTogether("")}
            onChangePartner={() => go(VIEW.TOGETHER)}
            excluded={preferences.excludedGenres}
            onToggleGenre={toggleExcludedGenre}
            onClearGenres={() => changePreferences({ excludedGenres: [] })}
          />
        )}
        {view === VIEW.THINKING && (
          <ScreenThinking
            onLog={nav.log}
            status={status}
            mood={thinkingMood}
            heard={heardMood}
            watchedCount={mode === "manual" ? 0 : malList.length}
            mode={mode}
          />
        )}
        {view === VIEW.REVEAL && revealEntry && (
          <ScreenReveal
            key={revealEntry.id}
            nav={nav}
            entry={revealEntry}
            isNewPick={isNewPick}
            canMarkSeen={canMarkSeen}
            canPassTonight={canPassTonight}
          />
        )}
        {view === VIEW.FEEDBACK && revealEntry && (
          <ScreenFeedback nav={nav} pick={revealEntry.recommendation} />
        )}
        {view === VIEW.HISTORY && (
          <ScreenHistory
            nav={nav}
            history={history}
            source={mode === "username" ? "username" : mode === "manual" || !tokens?.access_token ? "manual" : "mal"}
            listSource={loadListSource()}
            malSync={preferences.malSync}
            sync={{ settings: syncSettings, ...syncState }}
          />
        )}
        {view === VIEW.KNOWS && (
          <ScreenKnows
            nav={nav}
            knows={knows}
            history={history}
            preferences={preferences}
            onChange={changePreferences}
            onToggleGenre={toggleExcludedGenre}
            onRetry={() => setKnows({ status: "idle", reload: Date.now() })}
            mode={mode}
            listSource={loadListSource()}
            catchingUp={catchingUp}
          />
        )}
      </div>
    </NavContext.Provider>
  );
}

function ErrorRibbon({ message, onDismiss }) {
  return (
    <div
      className="meta"
      role="alert"
      style={{
        position: "fixed",
        top: 72,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 20,
        maxWidth: 520,
        width: "calc(100% - 32px)",
        padding: "14px 18px",
        border: "1px solid var(--hairline-strong)",
        background: "rgba(13,12,11,0.92)",
        color: "var(--bone-2)",
        textAlign: "center"
      }}
    >
      {message}
      <div>
        <button className="btn-quiet" onClick={onDismiss} style={{ marginTop: 6, paddingBottom: 0 }}>
          dismiss
        </button>
      </div>
    </div>
  );
}

// The wordmark doubles as the home link.
function Wordmark({ subtle }) {
  const nav = useContext(NavContext);
  return (
    <button
      className="wordmark"
      onClick={nav?.home}
      aria-label="En, home"
      style={{ opacity: subtle ? 0.85 : 1 }}
    >
      <span className="kanji">縁</span>
      <span style={{ fontStyle: "italic", fontSize: 20, letterSpacing: "0.04em" }}>
        En
      </span>
    </button>
  );
}

function ChromeLeft() {
  const nav = useContext(NavContext);
  return (
    <div className="chrome-left">
      <Wordmark />
      {nav?.canGoBack && (
        <button className="btn-quiet" onClick={nav.back}>
          ← back
        </button>
      )}
    </div>
  );
}

function Chrome({ step, total, right, onLog }) {
  return (
    <div className="app-chrome">
      <ChromeLeft />
      <div className="chrome-right">
        {step != null && (
          <span className="meta chrome-step" style={{ letterSpacing: "0.18em" }}>
            {String(step).padStart(2, "0")}{" "}
            <span style={{ opacity: 0.5 }}>
              / {String(total).padStart(2, "0")}
            </span>
          </span>
        )}
        {right}
        <button className="btn-quiet" onClick={onLog}>
          LOG
        </button>
      </div>
    </div>
  );
}

function KV({ label = "key visual", src = "", w = 280, h = 400, style }) {
  return (
    <div className="kv-placeholder" style={{ width: w, height: h, ...style }}>
      {src ? <img src={src} alt="" /> : <span className="kv-label">{label}</span>}
    </div>
  );
}

function ScreenLanding({ nav, status }) {
  return (
    <div className="app-frame">
      <Chrome onLog={nav.log} />
      <div className="app-stage">
        <div className="column column-narrow" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">An anime sommelier</div>

          <h1 className="serif-display landing-title fade-up delay-1">
            One anime.
            <br />
            <span style={{ fontStyle: "italic", color: "var(--bone-2)" }}>
              Chosen for tonight.
            </span>
          </h1>

          <p className="landing-lede fade-up delay-2">
            En reads your watch history, listens to your mood, and gives you a
            single recommendation.
            <br />
            <br />
            <span style={{ color: "var(--bone-3)" }}>Not a list. Never a list.</span>
          </p>

          <div className="fade-up delay-3">
            <button className="btn-link" onClick={nav.connect}>
              Connect MyAnimeList
            </button>
            <div style={{ marginTop: 24 }}>
              <button className="btn-link" onClick={nav.manualStart}>
                I'll tell En myself
              </button>
            </div>
            <div style={{ marginTop: 20 }}>
              <button className="btn-quiet" onClick={nav.usernameStart}>
                or — just my MyAnimeList / AniList username
              </button>
            </div>
          </div>

          {status ? (
            <p className="meta fade-up delay-4" style={{ marginTop: 36 }}>
              {status}
            </p>
          ) : null}

          <div className="landing-footnote fade-up delay-4">
            <hr className="hairline-soft" style={{ width: 60, margin: "0 auto 18px" }} />
            <p className="meta" style={{ fontSize: 11, letterSpacing: "0.18em" }}>
              縁 · the thread of fate that connects two people
            </p>
            <SuggestionNote />
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenManual({ onLog, onSubmit, manualList, setManualList }) {
  const ref = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="app-frame">
      <Chrome onLog={onLog} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">Instead of a library</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{ fontSize: 44, margin: "32px 0 14px", fontWeight: 300 }}
          >
            What have you watched?
          </h2>
          <p
            className="fade-up delay-2"
            style={{
              color: "var(--bone-3)",
              fontSize: 15,
              marginBottom: 80,
              fontStyle: "italic"
            }}
          >
            Just anime you've seen and loved.
          </p>

          <div
            className="fade-up delay-3"
            style={{ position: "relative", maxWidth: 620, margin: "0 auto" }}
          >
            <textarea
              ref={ref}
              value={manualList}
              onChange={(e) => setManualList(e.target.value)}
              onKeyDown={submitOnEnter(() => manualList.trim() && onSubmit(manualList), { requireModifier: true })}
              aria-label="Anime you've watched and loved, separated by commas or new lines"
              rows={3}
              className="serif-display field field--grow"
              placeholder="Death Note, Your Name, Vinland Saga..."
              style={{
                width: "100%",
                fontSize: 28,
                textAlign: "center",
                lineHeight: 1.4,
                color: "var(--bone)",
                resize: "none",
                fontWeight: 300
              }}
            />
          </div>

          <div className="fade-up delay-4" style={{ marginTop: 80 }}>
            <button
              className="btn-link"
              onClick={() => onSubmit(manualList)}
              disabled={!manualList.trim()}
              style={{ transition: "opacity 0.4s ease" }}
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenPending({ nav, pending }) {
  if (!pending) {
    return null;
  }

  return (
    <div className="app-frame">
      <Chrome onLog={nav.log} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center", maxWidth: 560 }}>
          <div className="eyebrow fade-up">Before tonight</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{
              fontSize: 44,
              margin: "28px 0 14px",
              fontWeight: 300,
              fontStyle: "italic"
            }}
          >
            {pending.state === "watching"
              ? `Did you finish ${pending.recommendation.title}?`
              : pending.mode === "resume"
              ? `Did you get back to ${pending.recommendation.title}?`
              : pending.mode === "together"
              ? `Did you and ${pending.partner_name || "them"} watch ${pending.recommendation.title}?`
              : `Did you watch ${pending.recommendation.title}?`}
          </h2>
          <p className="meta fade-up delay-1">
            {pending.state === "watching"
              ? `Watching since ${formatDate(pending.watching_since || pending.date)}`
              : `${pending.state === "pending" ? "Saved" : "En picked it"} · ${formatDate(pending.date)}`}
          </p>

          <div className="choice-links fade-up delay-2" style={{ marginTop: 64 }}>
            <button className="btn-link" onClick={() => nav.pendingAnswer("good")}>
              It was good
            </button>
            <button className="btn-link" onClick={() => nav.pendingAnswer("meh")}>
              Meh
            </button>
            <button className="btn-link" onClick={() => nav.pendingAnswer("watching")}>
              {pending.state === "watching" ? "Still watching" : "Watching it"}
            </button>
            <button className="btn-link" onClick={() => nav.pendingAnswer("later")}>
              {pending.state === "watching" ? "I'll finish it later" : "I'll watch it later"}
            </button>
            <button className="btn-quiet" onClick={() => nav.pendingAnswer("pass")}>
              I'll pass on it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenMood({ onLog, onConsider, onSurprise, onShortlist, onTogether, mood, setMood, excluded, onToggleGenre, onClearGenres }) {
  const ref = useRef(null);
  const hints = useMemo(
    () => [
      "something quiet",
      "rain on a Tuesday",
      "long, slow, devastating",
      "isekai but smarter",
      "i need to feel something"
    ],
    []
  );
  const [hintIdx, setHintIdx] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 600);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setHintIdx((i) => (i + 1) % hints.length), 3200);
    return () => clearInterval(id);
  }, [hints]);

  return (
    <div className="app-frame">
      <Chrome step={1} total={3} onLog={onLog} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">Tonight</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{ fontSize: 44, margin: "32px 0 14px", fontWeight: 300 }}
          >
            How do you feel?
          </h2>
          <p
            className="fade-up delay-2"
            style={{
              color: "var(--bone-3)",
              fontSize: 15,
              marginBottom: 80,
              fontStyle: "italic"
            }}
          >
            A word, a sentence, or nothing at all.
          </p>

          <div
            className="fade-up delay-3"
            style={{ position: "relative", maxWidth: 560, margin: "0 auto" }}
          >
            <textarea
              ref={ref}
              value={mood}
              onChange={(e) => setMood(e.target.value)}
              onKeyDown={submitOnEnter(() => mood.trim() && onConsider())}
              aria-label="How do you feel tonight? A word, a sentence, or nothing at all."
              rows={2}
              className="serif-display field field--grow"
              style={{
                width: "100%",
                fontSize: 28,
                textAlign: "center",
                lineHeight: 1.4,
                color: "var(--bone)",
                resize: "none",
                fontWeight: 300
              }}
            />
            {!mood && (
              <div className="field-hint" aria-hidden="true">
                <span key={hintIdx} className="serif-display field fade-in">
                  {hints[hintIdx]}
                </span>
              </div>
            )}
          </div>

          <div className="fade-up delay-4" style={{ marginTop: 80 }}>
            <button
              className="btn-link"
              onClick={onConsider}
              disabled={!mood.trim()}
              style={{ transition: "opacity 0.4s ease" }}
            >
              Let En consider
            </button>
            <div style={{ marginTop: 24 }}>
              <button className="btn-quiet" onClick={onSurprise}>
                or — surprise me
              </button>
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="btn-quiet" onClick={onShortlist}>
                or — I already have one in mind
              </button>
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="btn-quiet" onClick={onTogether}>
                or — for two
              </button>
            </div>
            <LeaveOut excluded={excluded} onToggle={onToggleGenre} onClear={onClearGenres} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenShortlist({ onLog, onSubmit, shortlist, setShortlist }) {
  const ref = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="app-frame">
      <Chrome step={1} total={3} onLog={onLog} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">Instead of a mood</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{ fontSize: 44, margin: "32px 0 14px", fontWeight: 300 }}
          >
            What are you considering?
          </h2>
          <p
            className="fade-up delay-2"
            style={{
              color: "var(--bone-3)",
              fontSize: 15,
              marginBottom: 80,
              fontStyle: "italic"
            }}
          >
            One title, or a few you're torn between.
          </p>

          <div
            className="fade-up delay-3"
            style={{ position: "relative", maxWidth: 620, margin: "0 auto" }}
          >
            <textarea
              ref={ref}
              value={shortlist}
              onChange={(e) => setShortlist(e.target.value)}
              onKeyDown={submitOnEnter(() => shortlist.trim() && onSubmit(shortlist), { requireModifier: true })}
              aria-label="The anime you're considering: one title, or a few separated by vs, or, or new lines"
              rows={2}
              className="serif-display field field--grow"
              placeholder="Chainsaw Man, or Chainsaw Man vs Frieren..."
              style={{
                width: "100%",
                fontSize: 28,
                textAlign: "center",
                lineHeight: 1.4,
                color: "var(--bone)",
                resize: "none",
                fontWeight: 300
              }}
            />
          </div>

          <div className="fade-up delay-4" style={{ marginTop: 80 }}>
            <button
              className="btn-link"
              onClick={() => onSubmit(shortlist)}
              disabled={!shortlist.trim()}
              style={{ transition: "opacity 0.4s ease" }}
            >
              Ask En
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenShortlistMood({ onLog, titles, mood, setMood, onSubmit, onSkip }) {
  const ref = useRef(null);
  const isSingle = titles.length <= 1;

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="app-frame">
      <Chrome step={2} total={3} onLog={onLog} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">{isSingle ? "Considering" : "Choosing between"}</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{ fontSize: 32, margin: "24px 0 14px", fontWeight: 300, fontStyle: "italic" }}
          >
            {titles.join(" · ")}
          </h2>
          <p
            className="fade-up delay-2"
            style={{
              color: "var(--bone-3)",
              fontSize: 15,
              marginBottom: 64,
              fontStyle: "italic"
            }}
          >
            {isSingle
              ? "What are you in the mood for tonight? Or — why this one, tonight?"
              : "What are you in the mood for tonight? Or — why these, tonight?"}
          </p>

          <div
            className="fade-up delay-3"
            style={{ position: "relative", maxWidth: 560, margin: "0 auto" }}
          >
            <textarea
              ref={ref}
              value={mood}
              onChange={(e) => setMood(e.target.value)}
              onKeyDown={submitOnEnter(onSubmit)}
              aria-label="Tonight's mood, or why you're considering these. Optional."
              rows={2}
              className="serif-display field field--grow"
              placeholder="something quiet, or nothing at all"
              style={{
                width: "100%",
                fontSize: 26,
                textAlign: "center",
                lineHeight: 1.4,
                color: "var(--bone)",
                resize: "none",
                fontWeight: 300
              }}
            />
          </div>

          <div className="fade-up delay-4" style={{ marginTop: 72 }}>
            <button className="btn-link" onClick={onSubmit}>
              Let En decide
            </button>
            <div style={{ marginTop: 20 }}>
              <button className="btn-quiet" onClick={onSkip}>
                or — no particular mood, just pick
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Username sign-in: a public MyAnimeList or AniList list, no login.
function ScreenUsername({ onLog, source, checking, onSubmit }) {
  const [kind, setKind] = useState(source?.kind || "mal");
  const [username, setUsername] = useState(source?.username || "");
  const ref = useRef(null);
  const site = kind === "anilist" ? "AniList" : "MyAnimeList";
  const ready = !checking && username.trim();
  const submit = () => ready && onSubmit({ kind, username });

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 600);
    return () => clearTimeout(t);
  }, [kind]);

  return (
    <div className="app-frame">
      <Chrome onLog={onLog} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">Your list</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{ fontSize: 44, margin: "32px 0 14px", fontWeight: 300 }}
          >
            What's your username?
          </h2>
          <p
            className="fade-up delay-2"
            style={{ color: "var(--bone-3)", fontSize: 15, marginBottom: 64, fontStyle: "italic" }}
          >
            Your {site} username. En reads your public list; no sign-in needed.
          </p>

          <div className="fade-up delay-3" style={{ maxWidth: 560, margin: "0 auto" }}>
            <input
              ref={ref}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={submitOnEnter(submit)}
              aria-label={`Your ${site} username`}
              placeholder={`your ${site} username`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="meh-note-input"
            />
          </div>

          <div className="fade-up delay-4" style={{ marginTop: 64 }}>
            <button className="btn-link" onClick={submit} disabled={!ready} style={{ transition: "opacity 0.4s ease" }}>
              {checking ? "Reading your list…" : "Continue"}
            </button>
            <div style={{ marginTop: 20 }}>
              <button className="btn-quiet" onClick={() => setKind(kind === "anilist" ? "mal" : "anilist")}>
                {kind === "anilist" ? "or — I'm on MyAnimeList" : "or — I'm on AniList"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// "For two", step one: whose list to read alongside the user's, or a link
// so they can add it themselves from their own phone.
function ScreenTogether({ onLog, partner, checking, onSubmit, onCreateRoom, myName }) {
  const [kind, setKind] = useState(partner?.kind || "mal");
  const [username, setUsername] = useState(partner?.kind === "mal" ? partner.username : "");
  const [name, setName] = useState(partner?.kind === "manual" ? partner.name : "");
  const [list, setList] = useState(partner?.kind === "manual" ? partner.list : "");
  const [me, setMe] = useState(myName || "");
  const [creating, setCreating] = useState(false);
  const ref = useRef(null);
  const ready = !checking && !creating && (kind === "mal" ? username.trim() : kind === "manual" ? list.trim() : true);
  const submit = async () => {
    if (!ready) return;
    if (kind === "link") {
      setCreating(true);
      await onCreateRoom(me);
      setCreating(false);
      return;
    }
    onSubmit({ kind, username, name, list });
  };

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 600);
    return () => clearTimeout(t);
  }, [kind]);

  return (
    <div className="app-frame">
      <Chrome onLog={onLog} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">For two</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{ fontSize: 44, margin: "32px 0 14px", fontWeight: 300 }}
          >
            Who's watching with you?
          </h2>
          <p
            className="fade-up delay-2"
            style={{ color: "var(--bone-3)", fontSize: 15, marginBottom: 64, fontStyle: "italic" }}
          >
            {kind === "mal"
              ? "Their MyAnimeList username. En reads their public list; they don't need to sign in."
              : kind === "manual"
                ? "What they've seen and loved, and what to call them."
                : "Send them a link. They add their own list and mood on their phone, and you both get the same pick."}
          </p>

          <div className="fade-up delay-3" style={{ maxWidth: 560, margin: "0 auto" }}>
            {kind === "mal" ? (
              <input
                ref={ref}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                onKeyDown={submitOnEnter(submit)}
                aria-label="Their MyAnimeList username"
                placeholder="their username"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="meh-note-input"
              />
            ) : kind === "manual" ? (
              <>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-label="Their name (optional)"
                  placeholder="their name"
                  className="meh-note-input"
                />
                <textarea
                  ref={ref}
                  value={list}
                  onChange={(event) => setList(event.target.value)}
                  onKeyDown={submitOnEnter(submit, { requireModifier: true })}
                  aria-label="Anime they've watched and loved, separated by commas or new lines"
                  rows={3}
                  className="serif-display field field--grow"
                  placeholder="Frieren, Mushishi, Your Name..."
                  style={{ width: "100%", fontSize: 24, textAlign: "center", lineHeight: 1.4, color: "var(--bone)", resize: "none", fontWeight: 300, marginTop: 28 }}
                />
              </>
            ) : (
              <input
                ref={ref}
                value={me}
                onChange={(event) => setMe(event.target.value)}
                onKeyDown={submitOnEnter(submit)}
                aria-label="Your name, so they know who's asking"
                placeholder="your name, so they know who's asking"
                maxLength={40}
                className="meh-note-input"
              />
            )}
          </div>

          <div className="fade-up delay-4" style={{ marginTop: 64 }}>
            <button className="btn-link" onClick={submit} disabled={!ready} style={{ transition: "opacity 0.4s ease" }}>
              {kind === "link" ? (creating ? "Making the link…" : "Make the link") : checking ? "Reading their list…" : "Continue"}
            </button>
            {kind === "link" ? (
              <div style={{ marginTop: 20 }}>
                <button className="btn-quiet" onClick={() => setKind("mal")}>
                  or — add their list myself
                </button>
              </div>
            ) : (
              <>
                <div style={{ marginTop: 20 }}>
                  <button className="btn-quiet" onClick={() => setKind(kind === "mal" ? "manual" : "mal")}>
                    {kind === "mal" ? "or — type what they've loved instead" : "or — use their MyAnimeList"}
                  </button>
                </div>
                <div style={{ marginTop: 12 }}>
                  <button className="btn-quiet" onClick={() => setKind("link")}>
                    or — send them a link, from their own phone
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// "For two, from two phones": the link's page. The host shares it and says
// what they're in the mood for; the other person adds their list and mood;
// the pick then shows up on both (see the room handlers in App).
function ScreenRoom({ nav, roomId, room, local, history, joining, ownList, myName }) {
  if (room.status === "gone" || room.status === "error") {
    return (
      <RoomFrame nav={nav} eyebrow="For two">
        <h2 className="serif-display fade-up delay-1" style={{ fontSize: 40, margin: "32px 0 14px", fontWeight: 300 }}>
          {room.status === "gone" ? "This link has run out" : "En couldn't open the link"}
        </h2>
        <p className="fade-up delay-2" style={{ color: "var(--bone-3)", fontSize: 15, fontStyle: "italic" }}>
          {room.status === "gone" ? "Links last twelve hours. Ask for a new one, or pick something on your own." : room.error}
        </p>
        <div className="fade-up delay-3" style={{ marginTop: 48 }}>
          <button className="btn-link" onClick={nav.newRecommendation}>
            Pick something on my own
          </button>
        </div>
      </RoomFrame>
    );
  }
  if (room.status !== "ready") {
    return (
      <RoomFrame nav={nav} eyebrow="For two">
        <h2 className="visually-hidden">Opening the link</h2>
        <div className="breathe" aria-hidden="true" style={{ marginTop: 40 }}>
          <span className="dot" style={{ width: 8, height: 8 }}></span>
        </div>
        <p className="meta" role="status" style={{ marginTop: 24 }}>
          Opening the link…
        </p>
      </RoomFrame>
    );
  }
  return local?.role === "host" ? (
    <RoomHost nav={nav} roomId={roomId} data={room.data} local={local} history={history} />
  ) : (
    <RoomGuest nav={nav} roomId={roomId} data={room.data} local={local} history={history} joining={joining} ownList={ownList} myName={myName} />
  );
}

function RoomFrame({ nav, eyebrow, children }) {
  return (
    <div className="app-frame">
      <Chrome onLog={nav.log} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">{eyebrow}</div>
          {children}
        </div>
      </div>
    </div>
  );
}

function RoomHost({ nav, roomId, data, local, history }) {
  const [mood, setMood] = useState(local.hostMood || "");
  const [copied, setCopied] = useState("");
  const link = roomLink(roomId);
  const guest = data.guest;
  const latest = data.picks.at(-1);
  const pickEntry = latest && history.find((entry) => entry.id === latest.id);
  const them = guest?.name || "They";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("copied");
    } catch {
      setCopied("select the link and copy it");
    }
    setTimeout(() => setCopied(""), 2500);
  }

  async function shareLink() {
    try {
      await navigator.share({ title: "En", text: "Pick something to watch with me on En", url: link });
    } catch {
      // closed the share sheet; nothing to do
    }
  }

  return (
    <RoomFrame nav={nav} eyebrow="For two, from two phones">
      <h2 className="serif-display fade-up delay-1" style={{ fontSize: 40, margin: "32px 0 14px", fontWeight: 300 }}>
        {guest ? `${them} ${guest.name ? "is" : "are"} in` : "Send them this link"}
      </h2>
      <p className="fade-up delay-2" style={{ color: "var(--bone-3)", fontSize: 15, fontStyle: "italic", lineHeight: 1.6 }}>
        {guest
          ? guest.mood
            ? `They're in the mood for “${guest.mood}”.`
            : "They didn't say what they're in the mood for."
          : "They open it on their phone and add their own list and mood. En picks one for both of you."}
      </p>

      {!pickEntry && (
        <div className="fade-up delay-3" style={{ marginTop: 36 }}>
          <div className="room-link" aria-label="The link to send">{link}</div>
          <div className="log-panel__actions" style={{ justifyContent: "center" }}>
            <button className="btn-quiet" onClick={copyLink}>
              {copied || "copy the link"}
            </button>
            {typeof navigator.share === "function" && (
              <button className="btn-quiet" onClick={shareLink}>
                share it
              </button>
            )}
          </div>
          {!guest && (
            <p className="meta room-waiting" role="status">
              <span className="dot breathe" aria-hidden="true"></span> waiting for them to open it
            </p>
          )}
        </div>
      )}

      <div className="fade-up delay-4" style={{ marginTop: 48 }}>
        {pickEntry ? (
          <>
            <p style={{ color: "var(--bone-2)", fontSize: 18, fontStyle: "italic", margin: "0 0 24px" }}>
              En picked {pickEntry.recommendation.title} for you both.
            </p>
            <button className="btn-link" onClick={() => nav.openPick(pickEntry.id)}>
              See it
            </button>
          </>
        ) : local.ready ? (
          <p className="meta" role="status">
            {guest ? "Choosing…" : "Ready. En will choose as soon as they're in."}
          </p>
        ) : (
          <>
            <textarea
              value={mood}
              onChange={(event) => setMood(event.target.value)}
              onKeyDown={submitOnEnter(() => nav.roomReady(roomId, mood))}
              aria-label="What are you in the mood for? Optional."
              rows={2}
              className="serif-display field field--grow room-mood"
              placeholder="what are you in the mood for?"
              style={{ marginBottom: 40 }}
            />
            <button className="btn-link" onClick={() => nav.roomReady(roomId, mood)}>
              {guest ? "Let En choose for two" : "I'm ready"}
            </button>
          </>
        )}
      </div>
    </RoomFrame>
  );
}

function RoomGuest({ nav, roomId, data, local, history, joining, ownList, myName }) {
  const host = data.hostName || "Someone";
  const hostShort = data.hostName || "them";
  const [source, setSource] = useState(ownList ? "own" : "mal");
  const [username, setUsername] = useState("");
  const [list, setList] = useState("");
  const [name, setName] = useState(myName || "");
  const [mood, setMood] = useState(local?.guestMood || "");
  const latest = data.picks.at(-1);
  const pickEntry = latest && history.find((entry) => entry.room_pick_id === latest.id);
  const passed = pickEntry?.state === "not_tonight";

  if (!local?.joined) {
    const ready = !joining && (source === "own" || (source === "typed" ? list.trim() : username.trim()));
    const send = () => ready && nav.joinRoom(roomId, { name, mood, source: { kind: source, username, list } });
    const site = source === "anilist" ? "AniList" : "MyAnimeList";
    return (
      <RoomFrame nav={nav} eyebrow="For two">
        <h2 className="serif-display fade-up delay-1" style={{ fontSize: 40, margin: "32px 0 14px", fontWeight: 300 }}>
          {host} wants to pick something to watch with you
        </h2>
        <p className="fade-up delay-2" style={{ color: "var(--bone-3)", fontSize: 15, fontStyle: "italic", lineHeight: 1.6, marginBottom: 48 }}>
          Add your list and your mood. En reads both of you and picks one.
        </p>

        <div className="fade-up delay-3 room-form">
          <div className="eyebrow">Your list</div>
          {source === "own" ? (
            <p className="room-form__note">En will read your {ownList === "typed" ? "list" : `${ownList} list`}.</p>
          ) : source === "typed" ? (
            <>
              <textarea
                value={list}
                onChange={(event) => setList(event.target.value)}
                aria-label="Anime you've watched and loved, separated by commas or new lines"
                rows={2}
                className="serif-display field field--grow room-mood"
                placeholder="Frieren, Mushishi, Your Name..."
              />
            </>
          ) : (
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-label={`Your ${site} username`}
              placeholder={`your ${site} username`}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="meh-note-input"
            />
          )}
          <div className="log-panel__actions" style={{ justifyContent: "center" }}>
            {[
              ...(ownList ? [["own", "my En list"]] : []),
              ["mal", "MyAnimeList"],
              ["anilist", "AniList"],
              ["typed", "type it"]
            ]
              .filter(([value]) => value !== source)
              .map(([value, label]) => (
                <button key={value} className="btn-quiet" onClick={() => setSource(value)}>
                  or — {label}
                </button>
              ))}
          </div>

          <div className="eyebrow" style={{ marginTop: 36 }}>Your name</div>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label={`What should ${hostShort} call you?`}
            placeholder={`what should ${hostShort} call you?`}
            maxLength={40}
            className="meh-note-input"
          />

          <div className="eyebrow" style={{ marginTop: 36 }}>Tonight</div>
          <textarea
            value={mood}
            onChange={(event) => setMood(event.target.value)}
            onKeyDown={submitOnEnter(send)}
            aria-label="What are you in the mood for? Optional."
            rows={2}
            className="serif-display field field--grow room-mood"
            placeholder="what are you in the mood for?"
          />
        </div>

        <div className="fade-up delay-4" style={{ marginTop: 48 }}>
          <button className="btn-link" onClick={send} disabled={!ready} style={{ transition: "opacity 0.4s ease" }}>
            {joining ? "Reading your list…" : `Send to ${hostShort}`}
          </button>
          <p className="meta" style={{ marginTop: 24, fontSize: 11, lineHeight: 1.6 }}>
            Your list goes to En for this pick only, and is deleted within twelve hours.
          </p>
        </div>
      </RoomFrame>
    );
  }

  return (
    <RoomFrame nav={nav} eyebrow="For two">
      <h2 className="serif-display fade-up delay-1" style={{ fontSize: 40, margin: "32px 0 14px", fontWeight: 300 }}>
        {pickEntry && !passed ? `En picked ${pickEntry.recommendation.title}` : passed ? `Told ${hostShort}` : `${host} is choosing`}
      </h2>
      <p className="fade-up delay-2" style={{ color: "var(--bone-3)", fontSize: 15, fontStyle: "italic", lineHeight: 1.6 }}>
        {pickEntry && !passed
          ? "For the two of you."
          : passed
            ? "En is choosing another, for both of you."
            : data.hostMood
              ? `You said “${local.guestMood || "nothing in particular"}”. ${hostShort} said “${data.hostMood}”. En is reading both lists.`
              : `En has your list. It picks once ${hostShort} says what they're in the mood for.`}
      </p>
      <div className="fade-up delay-3" style={{ marginTop: 48 }}>
        {pickEntry && !passed ? (
          <button className="btn-link" onClick={() => nav.openPick(pickEntry.id)}>
            See it
          </button>
        ) : (
          <div className="breathe" aria-hidden="true">
            <span className="dot" style={{ width: 8, height: 8 }}></span>
          </div>
        )}
      </div>
    </RoomFrame>
  );
}

// "For two", step two: tonight's mood, for both of them.
function ScreenTogetherMood({ onLog, name, mood, setMood, onSubmit, onSurprise, onChangePartner, excluded, onToggleGenre, onClearGenres }) {
  const ref = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="app-frame">
      <Chrome onLog={onLog} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <div className="eyebrow fade-up">{name === "them" ? "The two of you" : `You and ${name}`}</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{ fontSize: 44, margin: "32px 0 14px", fontWeight: 300 }}
          >
            What are you two in the mood for?
          </h2>
          <p
            className="fade-up delay-2"
            style={{ color: "var(--bone-3)", fontSize: 15, marginBottom: 64, fontStyle: "italic" }}
          >
            En reads both lists and picks one for the two of you.
          </p>

          <div className="fade-up delay-3" style={{ position: "relative", maxWidth: 560, margin: "0 auto" }}>
            <textarea
              ref={ref}
              value={mood}
              onChange={(event) => setMood(event.target.value)}
              onKeyDown={submitOnEnter(() => mood.trim() && onSubmit())}
              aria-label="What are you two in the mood for?"
              rows={2}
              className="serif-display field field--grow"
              placeholder="something we'll both talk about after"
              style={{ width: "100%", fontSize: 26, textAlign: "center", lineHeight: 1.4, color: "var(--bone)", resize: "none", fontWeight: 300 }}
            />
          </div>

          <div className="fade-up delay-4" style={{ marginTop: 64 }}>
            <button className="btn-link" onClick={onSubmit} disabled={!mood.trim()} style={{ transition: "opacity 0.4s ease" }}>
              Let En choose for two
            </button>
            <div style={{ marginTop: 20 }}>
              <button className="btn-quiet" onClick={onSurprise}>
                or — surprise us
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              <button className="btn-quiet" onClick={onChangePartner}>
                or — watching with someone else
              </button>
            </div>
            <LeaveOut excluded={excluded} onToggle={onToggleGenre} onClear={onClearGenres} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenThinking({ onLog, status, mood, heard, watchedCount, mode }) {
  const [phase, setPhase] = useState(0);
  const lines = useMemo(() => {
    const sourceLine = mode === "manual" ? "Reading what you told En" : "Reading your history";
    const listLine = watchedCount ? `${formatCount(watchedCount)} titles` : "Your list is opening";
    const moodLine = !mood ? "Letting tonight choose itself" : heard ? `Tonight sounds ${heard}` : "Listening to tonight";
    const baseLines = mode === "manual" ? [sourceLine, moodLine] : [sourceLine, listLine, moodLine];
    const finalLine = status && !baseLines.includes(status) ? status : "Considering";

    return [...baseLines, finalLine];
  }, [mode, mood, heard, status, watchedCount]);

  useEffect(() => {
    const timers = [];
    lines.forEach((_, i) => {
      timers.push(setTimeout(() => setPhase((p) => Math.max(p, i + 1)), 800 + i * 1100));
    });
    return () => timers.forEach(clearTimeout);
  }, [lines]);

  return (
    <div className="app-frame">
      <Chrome step={2} total={3} onLog={onLog} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center" }}>
          <h2 className="visually-hidden">En is choosing</h2>
          <p className="visually-hidden" role="status" aria-live="polite">
            {lines[phase - 1] || ""}
          </p>
          <div className="breathe" style={{ marginBottom: 64 }} aria-hidden="true">
            <span className="dot" style={{ width: 8, height: 8 }}></span>
          </div>

          <div style={{ minHeight: 140 }} aria-hidden="true">
            {lines.slice(0, phase).map((line, i) => (
              <div
                key={`${line}-${i}`}
                className="serif-display fade-up"
                style={{
                  fontSize: 22,
                  fontWeight: 300,
                  color: i === phase - 1 ? "var(--bone-2)" : "var(--bone-4)",
                  fontStyle: "italic",
                  margin: "14px 0",
                  transition: "color 1s ease"
                }}
              >
                {line}
                {i === phase - 1 && "…"}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const NOT_TONIGHT_REASONS = [
  ["too long", "too long"],
  ["too heavy", "too heavy"],
  ["too light", "too light"],
  ["just not it", ""]
];

function ScreenReveal({ nav, entry, isNewPick, canMarkSeen, canPassTonight }) {
  const pick = entry.recommendation;
  const [settled, setSettled] = useState("");
  const [choosingReason, setChoosingReason] = useState(false);

  return (
    <div className="app-frame reveal-a-frame">
      <div className="reveal-a-top">
        <ChromeLeft />
        <div className="chrome-right">
          {isNewPick && <span className="meta chrome-step" style={{ letterSpacing: "0.2em" }}>03 / 03</span>}
          <button className="btn-quiet" onClick={nav.log}>
            LOG
          </button>
        </div>
      </div>

      <div className="reveal-scroll-stage">
        <div className="reveal-scroll ink-bloom">
          <div
            className="reveal-scroll__vertical jp ink-bloom delay-1"
          >
            {pick.title_jp} ・ {formatJapaneseDate(new Date(entry.date))}
          </div>

          <div className="reveal-scroll__center ink-bloom delay-2">
            <KV label="key visual" src={pick.image_url} w={240} h={340} />
            <p
              className="meta"
              style={{
                marginTop: 12,
                fontSize: 10.5,
                letterSpacing: "0.22em"
              }}
            >
              {formatAnimeMeta(pick)}
            </p>
            {pick.resume ? (
              <p className="meta" style={{ marginTop: 6, fontSize: 10.5, letterSpacing: "0.16em", textAlign: "center" }}>
                you stopped at episode {pick.resume.watched}
                {pick.resume.total ? ` of ${pick.resume.total}` : ""}
              </p>
            ) : null}
            {pick.watch_links?.length ? (
              <>
                <p className="meta watch-links">
                  <span>streams on</span>
                  {pick.watch_links.map((link) => (
                    <a key={link.site} href={link.url} target="_blank" rel="noopener noreferrer">
                      {link.site}
                    </a>
                  ))}
                </p>
                <p className="meta watch-links__note">
                  What plays depends on your region, so a link may be blocked or hidden where you are.
                </p>
              </>
            ) : null}
          </div>

          <div className="reveal-scroll__copy ink-bloom delay-3">
            <div className="eyebrow shu">
              {pick.resume
                ? "・ pick up where you left off"
                : pick.mode === "together"
                ? `・ for you and ${pick.partner_name || "them"}`
                : pick.mode === "choose"
                ? `・ over ${pick.chooseAgainst?.join(", ") || "the rest"}`
                : pick.verdict === "yes"
                  ? `・ yes — ${pick.queried_title}`
                  : pick.verdict === "no"
                    ? `・ not ${pick.queried_title} — this instead`
                    : isNewPick
                      ? "・ for you, tonight"
                      : "・ chosen for you"}
            </div>
            <h1
              className="serif-display reveal-scroll__title"
            >
              {pick.title}
            </h1>

            <hr
              className="hairline"
              style={{ width: 56, margin: "0 0 28px" }}
            />

            <p
              className="reveal-scroll__reason"
              style={{
                color: "var(--bone-2)",
                fontWeight: 300
              }}
            >
              {stripMarkdown(pick.reason)}
            </p>

            {/* The pick is already in the log; these only say what happens next. */}
            <div style={{ marginTop: 36 }}>
              {!settled && !isNewPick ? (
                <PastPickAnswer entry={entry} onAnswer={nav.answer} />
              ) : settled ? (
                <p
                  className="fade-in"
                  role="status"
                  style={{ color: "var(--bone-3)", fontStyle: "italic", fontSize: 15, margin: 0 }}
                >
                  {settled === "later"
                    ? "Saved. En will ask about it later."
                    : "Enjoy it. En will ask how it was next time."}
                </p>
              ) : (
                <>
                  <button
                    className="btn-link"
                    onClick={() => {
                      nav.watchTonight();
                      setSettled("tonight");
                    }}
                  >
                    Watch it tonight
                  </button>
                  <div style={{ marginTop: 20 }}>
                    <button
                      className="btn-quiet"
                      onClick={() => {
                        nav.saveForLater();
                        setSettled("later");
                      }}
                    >
                      or — save for later
                    </button>
                  </div>
                  {canMarkSeen && (
                    <div style={{ marginTop: 8 }}>
                      <button className="btn-quiet" onClick={nav.seenIt}>
                        or — I've already seen it
                      </button>
                    </div>
                  )}
                  {canPassTonight && (
                    <div style={{ marginTop: 8 }}>
                      {choosingReason ? (
                        <div className="answer-controls" role="group" aria-label="Why not tonight?" style={{ marginTop: 0 }}>
                          <span className="meta answer-controls__prompt">why not?</span>
                          {NOT_TONIGHT_REASONS.map(([label, reason]) => (
                            <button key={label} className="btn-quiet" onClick={() => nav.notTonight(reason)}>
                              {label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <button className="btn-quiet" onClick={() => setChoosingReason(true)}>
                          or — not tonight
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <div style={{ marginTop: 28 }}>
              <ShareButton key={entry.id} onShare={() => nav.share(entry)} />
            </div>
          </div>
        </div>
        <div className="reveal-scroll__seal meta jp">縁</div>
      </div>
    </div>
  );
}

// Reached from "I've already seen it": how it landed is still a taste
// signal, and then En picks again.
function ScreenFeedback({ nav, pick }) {
  const [chosen, setChosen] = useState(null);
  const [mehNote, setMehNote] = useState("");

  function choose(value) {
    setChosen(value);
    if (value !== "meh") {
      setTimeout(() => nav.seenFeedback(value), 650);
    }
  }

  return (
    <div className="app-frame">
      <Chrome onLog={nav.log} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center", maxWidth: 560 }}>
          <div className="eyebrow fade-up">Already seen</div>

          <h2
            className="serif-display fade-up delay-1"
            style={{
              fontSize: 36,
              margin: "28px 0 8px",
              fontWeight: 300,
              fontStyle: "italic"
            }}
          >
            {pick.title}
          </h2>
          <p className="meta fade-up delay-1" style={{ marginBottom: 80 }}>
            How was it?
          </p>

          <div className="choice-links fade-up delay-2">
            {[
              { k: "good", label: "It was good" },
              { k: "meh", label: "Meh" }
            ].map((opt) => (
              <button
                key={opt.k}
                onClick={() => choose(opt.k)}
                className={chosen === opt.k ? "btn-link choice-links__active" : "btn-link"}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {chosen && (
            <p
              className="fade-in"
              style={{
                marginTop: 40,
                color: "var(--bone-3)",
                fontStyle: "italic",
                fontSize: 15
              }}
            >
              {chosen === "good"
                ? "Noted. En will find you another."
                : "Tell En what missed, or leave it blank."}
            </p>
          )}

          {chosen === "meh" && (
            <div className="fade-in" style={{ marginTop: 28 }}>
              <input
                value={mehNote}
                onChange={(event) => setMehNote(event.target.value)}
                onKeyDown={submitOnEnter(() => nav.seenFeedback("meh", mehNote))}
                aria-label="What didn't land? Optional."
                placeholder="what didn't land?"
                className="meh-note-input"
              />
              <div className="choice-links" style={{ marginTop: 24, gap: 16 }}>
                <button className="btn-link" onClick={() => nav.seenFeedback("meh", mehNote)}>
                  Save
                </button>
                <button className="btn-quiet" onClick={() => nav.seenFeedback("meh", "")}>
                  skip
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ANSWERS = [
  ["good", "good"],
  ["meh", "meh"],
  ["watching", "watching it"],
  ["later", "later"],
  ["pass", "pass"]
];

function currentAnswer(entry) {
  if (entry.state === "skipped") return "pass";
  if (entry.state === "watching") return "watching";
  if (entry.state === "pending") return "later";
  return entry.feedback || "";
}

function AnswerControls({ entry, onAnswer, prompt }) {
  const current = currentAnswer(entry);
  return (
    <div className="answer-controls">
      <span className="meta answer-controls__prompt">{prompt}</span>
      {ANSWERS.map(([answer, label]) => (
        <button
          key={answer}
          className={current === answer ? "btn-quiet answer-current" : "btn-quiet"}
          aria-pressed={current === answer}
          onClick={() => onAnswer(entry.id, answer)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// A pick reopened from the log: how it went, and a way to change that.
function PastPickAnswer({ entry, onAnswer }) {
  const [changing, setChanging] = useState(false);
  const askAgain = entry.ask_after && Date.parse(entry.ask_after) > Date.now() ? ` En asks again ${formatDate(entry.ask_after)}.` : "";
  const summary =
    entry.state === "pending"
      ? `Saved for later.${askAgain}`
      : entry.state === "watching"
        ? `You're watching it.${askAgain}`
      : entry.state === "unrated"
        ? "Not rated yet."
        : entry.state === "skipped"
          ? "You passed on it."
          : entry.state === "not_tonight"
            ? `You passed on it that night${entry.pass_reason ? ` (${entry.pass_reason})` : ""}.`
          : entry.feedback === "good"
            ? "You said it was good."
            : "You said meh.";

  return (
    <div>
      <p className="meta" style={{ margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 15 }}>
        {summary}
        {entry.state === "rated" && entry.note ? ` "${entry.note}"` : ""}
      </p>
      {isAwaitingAnswer(entry) ? (
        <AnswerControls entry={entry} onAnswer={onAnswer} prompt="how was it?" />
      ) : changing ? (
        <AnswerControls
          entry={entry}
          onAnswer={(id, answer) => {
            onAnswer(id, answer);
            setChanging(false);
          }}
          prompt="change it:"
        />
      ) : (
        <button className="btn-quiet" onClick={() => setChanging(true)} style={{ marginTop: 10 }}>
          change rating
        </button>
      )}
    </div>
  );
}

function ScreenHistory({ nav, history, source, listSource, malSync, sync }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="app-frame">
      <Chrome
        right={
          <button className="btn-quiet" onClick={nav.newRecommendation}>
            <span className="label-full">new recommendation</span>
            <span className="label-short">new</span> →
          </button>
        }
        onLog={nav.log}
      />
      <div className="app-stage" style={{ alignItems: "flex-start", paddingTop: 80 }}>
        <div className="column" style={{ maxWidth: 680 }}>
          <div className="eyebrow fade-up">A reading log</div>
          <h2
            className="serif-display fade-up delay-1"
            style={{ fontSize: 48, margin: "24px 0 8px", fontWeight: 300 }}
          >
            What En has chosen
          </h2>
          <p
            className="fade-up delay-2"
            style={{ color: "var(--bone-3)", fontStyle: "italic", marginBottom: 80 }}
          >
            {history.length
              ? `${history.length} recommendation${history.length === 1 ? "" : "s"}`
              : "No recommendations yet"}
          </p>

          <div
            className="fade-up delay-2"
            style={{
              display: "flex",
              columnGap: 22,
              rowGap: 4,
              marginTop: -48,
              marginBottom: 72,
              flexWrap: "wrap"
            }}
          >
            <button className="btn-quiet" onClick={nav.knows} style={{ color: "var(--bone-2)" }}>
              what En knows about you →
            </button>
            <button
              className="btn-quiet"
              onClick={() => setEditing((value) => !value)}
              disabled={!history.length}
            >
              {editing ? "done" : "edit log"}
            </button>
            <button
              className="btn-quiet"
              onClick={() => {
                nav.clearHistory();
                setEditing(false);
              }}
              disabled={!history.length}
            >
              clear log
            </button>
            {source === "mal" ? (
              <>
                <button className="btn-quiet" onClick={nav.toggleMalSync} aria-pressed={malSync === "on"}>
                  update MyAnimeList: {malSync === "on" ? "on" : "off"}
                </button>
                <button className="btn-quiet" onClick={nav.disconnect}>
                  disconnect MyAnimeList
                </button>
              </>
            ) : source === "username" ? (
              <>
                <button className="btn-quiet" onClick={nav.usernameStart}>
                  change username{listSource ? ` (${listSource.username}, ${sourceLabel(listSource)})` : ""}
                </button>
                <button className="btn-quiet" onClick={nav.connect}>
                  connect MyAnimeList
                </button>
              </>
            ) : (
              <>
                <button className="btn-quiet" onClick={nav.editManualList}>
                  edit your list
                </button>
                <button className="btn-quiet" onClick={nav.usernameStart}>
                  use a username
                </button>
                <button className="btn-quiet" onClick={nav.connect}>
                  connect MyAnimeList
                </button>
              </>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 56 }}>
            {history.map((entry, i) => (
              <article
                key={entry.id}
                className="fade-up"
                style={{
                  animationDelay: `${0.3 + Math.min(i, 5) * 0.12}s`,
                  display: "grid",
                  gridTemplateColumns: "110px 1fr",
                  gap: 32,
                  paddingBottom: 56,
                  borderBottom: i < history.length - 1 ? "1px solid var(--hairline)" : "none"
                }}
              >
                <div>
                  <div className="meta" style={{ fontSize: 10.5, letterSpacing: "0.18em" }}>
                    {formatDate(entry.date)}
                  </div>
                  <div
                    className="meta"
                    style={{
                      marginTop: 12,
                      fontSize: 10.5,
                      letterSpacing: "0.22em",
                      color: entry.feedback === "good" || entry.state === "pending" || entry.state === "watching"
                        ? "var(--shu)"
                        : "var(--bone-4)"
                    }}
                  >
                    {entry.state === "pending"
                      ? "○ later"
                      : entry.state === "watching"
                        ? "○ watching"
                      : entry.state === "unrated"
                        ? "○ unrated"
                        : entry.state === "skipped"
                          ? "— passed"
                          : entry.state === "not_tonight"
                            ? "— not tonight"
                          : entry.feedback === "good"
                            ? "・ good"
                            : entry.feedback === "meh"
                              ? "— meh"
                              : ""}
                  </div>
                  {entry.mode === "verdict" && (
                    <div
                      className="meta"
                      style={{ marginTop: 10, fontSize: 9.5, letterSpacing: "0.16em", color: "var(--bone-4)" }}
                    >
                      {entry.verdict === "yes" ? "asked · confirmed" : "asked · redirected"}
                    </div>
                  )}
                  {entry.mode === "choose" && (
                    <div
                      className="meta"
                      style={{ marginTop: 10, fontSize: 9.5, letterSpacing: "0.16em", color: "var(--bone-4)" }}
                    >
                      chose · from a shortlist
                    </div>
                  )}
                  {entry.mode === "resume" && (
                    <div
                      className="meta"
                      style={{ marginTop: 10, fontSize: 9.5, letterSpacing: "0.16em", color: "var(--bone-4)" }}
                    >
                      picked back up
                    </div>
                  )}
                  {entry.mode === "together" && (
                    <div
                      className="meta"
                      style={{ marginTop: 10, fontSize: 9.5, letterSpacing: "0.16em", color: "var(--bone-4)" }}
                    >
                      for two · with {entry.partner_name || "them"}
                    </div>
                  )}
                  {entry.answered_from && (
                    <div
                      className="meta"
                      style={{ marginTop: 10, fontSize: 9.5, letterSpacing: "0.16em", color: "var(--bone-4)" }}
                    >
                      from {entry.answered_from === "anilist" ? "AniList" : "MyAnimeList"}
                    </div>
                  )}
                  {entry.seen_before && (
                    <div
                      className="meta"
                      style={{ marginTop: 10, fontSize: 9.5, letterSpacing: "0.16em", color: "var(--bone-4)" }}
                    >
                      already seen
                    </div>
                  )}
                </div>

                <div>
                  <div className="jp" style={{ fontSize: 14, color: "var(--bone-3)", marginBottom: 4 }}>
                    {entry.recommendation.title_jp}
                  </div>
                  <h3
                    className="serif-display"
                    style={{ fontSize: 28, margin: 0, fontWeight: 300, fontStyle: "italic" }}
                  >
                    <a
                      href={pathFor(VIEW.REVEAL, entry.id)}
                      className="log-entry-link"
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                        event.preventDefault();
                        nav.openPick(entry.id);
                      }}
                    >
                      {entry.recommendation.title}
                    </a>
                  </h3>
                  <p
                    style={{
                      marginTop: 14,
                      color: "var(--bone-2)",
                      fontSize: 16,
                      lineHeight: 1.6,
                      fontWeight: 300,
                      maxWidth: 460
                    }}
                  >
                    <span
                      className="meta"
                      style={{
                        fontSize: 10,
                        marginRight: 10,
                        verticalAlign: "middle",
                        letterSpacing: "0.2em",
                        color: "var(--shu)"
                      }}
                    >
                      EN ·
                    </span>
                    <em style={{ fontStyle: "italic" }}>
                      {stripMarkdown(entry.recommendation.log_line || entry.recommendation.reason)}
                    </em>
                  </p>
                  {["rated", "skipped", "not_tonight"].includes(entry.state) && entry.note && (
                    <p
                      style={{
                        marginTop: 18,
                        fontFamily: "var(--serif)",
                        fontSize: 15,
                        fontStyle: "italic",
                        color: "var(--bone-3)",
                        paddingLeft: 18,
                        borderLeft: "1px solid var(--shu)",
                        opacity: 0.85
                      }}
                    >
                      <span
                        className="meta"
                        style={{
                          fontSize: 9.5,
                          letterSpacing: "0.22em",
                          marginRight: 8,
                          color: "var(--shu)"
                        }}
                      >
                        you ·
                      </span>
                      {entry.note}
                    </p>
                  )}
                  {isAwaitingAnswer(entry) ? (
                    <AnswerControls entry={entry} onAnswer={nav.answer} prompt="how was it?" />
                  ) : editing ? (
                    <AnswerControls entry={entry} onAnswer={nav.answer} prompt="change it:" />
                  ) : null}
                  {editing && (
                    <button
                      className="btn-quiet"
                      onClick={() => nav.deleteHistoryEntry(entry.id)}
                      style={{ marginTop: 22 }}
                    >
                      delete
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>

          <SyncPanel nav={nav} sync={sync} source={source} hasLog={history.length > 0} />

          <div style={{ textAlign: "center", marginTop: 80, paddingBottom: 80 }}>
            <p
              className="meta"
              style={{ fontStyle: "italic", fontFamily: "var(--serif)", fontSize: 14 }}
            >
              — and that is all, for now.
            </p>
            <SuggestionNote />
          </div>
        </div>
      </div>
    </div>
  );
}

// "Leave some genres out": a standing filter on every pick En makes, shown
// where tonight's pick is asked for.
function LeaveOut({ excluded = [], onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const doneRef = useRef(null);
  if (!open) {
    return (
      <div className="leave-out">
        <button className="btn-quiet" onClick={() => setOpen(true)} aria-expanded="false">
          {excluded.length ? `leaving out ${joinList(excluded)} · change` : "or — leave some genres out"}
        </button>
      </div>
    );
  }
  return (
    <div className="leave-out leave-out__panel fade-in">
      <p className="meta" style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 15 }}>
        Tap what En should never suggest. It stays left out until you let it back in.
      </p>
      <GenreChips excluded={excluded} onToggle={onToggle} />
      <div className="leave-out__actions">
        <button
          className="btn-quiet"
          disabled={!excluded.length}
          onClick={() => {
            onClear();
            doneRef.current?.focus();
          }}
        >
          clear all
        </button>
        <button ref={doneRef} className="btn-quiet" onClick={() => setOpen(false)} aria-expanded="true">
          done
        </button>
      </div>
    </div>
  );
}

function GenreChips({ excluded, onToggle, align = "center" }) {
  return (
    <div className={align === "left" ? "chips chips--left" : "chips"} role="group" aria-label="Genres to leave out">
      {EXCLUDABLE.map(({ label }) => (
        <button
          key={label}
          className="chip"
          aria-pressed={excluded.includes(label)}
          aria-label={`${label}${excluded.includes(label) ? ", left out" : ""}`}
          onClick={() => onToggle(label)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Notice({ notice, onDismiss, onMalOffer }) {
  useEffect(() => {
    if (notice?.kind !== "info") return undefined;
    const timer = setTimeout(onDismiss, 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  if (notice.kind === "mal-offer") {
    return (
      <div className="notice fade-in" role="dialog" aria-label="Update MyAnimeList too?">
        <p>
          Update your MyAnimeList too? When you tell En you're watching a pick, saving it or how it went, En can mark
          it on your list. It never changes a score, a drop or anything you've finished.
        </p>
        <div className="notice__actions">
          <button className="btn-quiet notice__yes" onClick={() => onMalOffer(true)}>
            yes, keep it in step
          </button>
          <button className="btn-quiet" onClick={() => onMalOffer(false)}>
            no thanks
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="notice fade-in" role="status">
      <p>{notice.text}</p>
      <div className="notice__actions">
        <button className="btn-quiet" onClick={onDismiss}>
          ok
        </button>
      </div>
    </div>
  );
}

// Where suggestions go: a Discord handle, with a copy button since Discord
// has no link that opens a chat by handle.
const DISCORD_HANDLE = "erenfrickinyeager";

function SuggestionNote() {
  const [copied, setCopied] = useState("");
  const handleRef = useRef(null);
  // The clipboard API is often blocked (embedded views, older browsers);
  // then select the handle and try the old copy command, and if even that
  // fails, the handle is left selected for the user to copy.
  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(DISCORD_HANDLE);
      ok = true;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(handleRef.current);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
    }
    setCopied(ok ? "copied" : "selected");
    setTimeout(() => setCopied(""), 2500);
  }
  return (
    <p className="suggestion-note">
      Got a suggestion, or something En got wrong? Message <span ref={handleRef} className="suggestion-note__handle">{DISCORD_HANDLE}</span> on
      Discord.{" "}
      <button className="btn-quiet" onClick={copy} aria-label={`Copy the Discord handle ${DISCORD_HANDLE}`}>
        {copied === "copied" ? "copied" : copied === "selected" ? "selected" : "copy"}
      </button>
      <span className="visually-hidden" role="status">
        {copied === "copied" ? "Copied" : copied === "selected" ? "Handle selected" : ""}
      </span>
    </p>
  );
}

function ShareButton({ onShare }) {
  const [state, setState] = useState("");
  return (
    <button
      className="btn-quiet"
      disabled={state === "busy"}
      onClick={async () => {
        setState("busy");
        const result = await onShare();
        setState(result === "downloaded" ? "downloaded" : "");
      }}
    >
      {state === "busy" ? "making the card…" : state === "downloaded" ? "card saved · make another" : "share this pick"}
    </button>
  );
}

// The log on other devices: syncing (by MAL account or by code), and a file
// to keep or carry by hand, which works even without syncing.
function SyncPanel({ nav, sync, source, hasLog }) {
  const { settings = {}, available, busy, error } = sync;
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState("");
  const [turningOff, setTurningOff] = useState(false);
  const fileRef = useRef(null);
  const viaMal = settings.via === "mal";

  let body;
  if (available === null) {
    body = <p>Checking…</p>;
  } else if (!available) {
    body = <p>Save the log as a file to keep a copy, or to load it on another device.</p>;
  } else if (settings.enabled) {
    body = (
      <>
        <p>
          {viaMal
            ? source === "mal"
              ? "Synced with your MyAnimeList account. Connect the same account on another device and the log is there."
              : "Synced with your MyAnimeList account. Connect MyAnimeList again to keep syncing."
            : "Synced with this code. On another device, open the log, choose “I have a sync code” and type it in."}
        </p>
        {!viaMal && <div className="sync-code" aria-label="Your sync code">{settings.code}</div>}
        <p className="meta" role="status" style={{ fontStyle: "normal", fontSize: 12 }}>
          {busy ? "syncing…" : error || (settings.lastSyncedAt ? `last synced ${formatTimeAgo(settings.lastSyncedAt)}` : "")}
        </p>
        <div className="log-panel__actions">
          {turningOff ? (
            <>
              <button className="btn-quiet" onClick={() => nav.syncOff()}>
                turn off, keep En's copy
              </button>
              <button className="btn-quiet" onClick={() => nav.syncOff({ forget: true })}>
                turn off and delete En's copy
              </button>
              <button className="btn-quiet" onClick={() => setTurningOff(false)}>
                cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn-quiet" onClick={nav.syncNow} disabled={busy}>
                sync now
              </button>
              <button className="btn-quiet" onClick={() => setTurningOff(true)}>
                turn off
              </button>
            </>
          )}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p>
          {source === "mal"
            ? "Keep this log, your answers and what you've told En on every device you use. It follows your MyAnimeList account."
            : "Keep this log, your answers and what you've told En on every device you use. En gives you a code to type in on the other one."}
        </p>
        {joining ? (
          <div style={{ marginTop: 14 }}>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={submitOnEnter(() => nav.syncOn(code) && setJoining(false))}
              aria-label="Sync code from your other device"
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="sync-code-input"
            />
            <div className="log-panel__actions">
              <button className="btn-quiet" onClick={() => nav.syncOn(code) && setJoining(false)} disabled={!code.trim()}>
                sync with this code
              </button>
              <button className="btn-quiet" onClick={() => setJoining(false)}>
                cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="log-panel__actions">
            <button className="btn-quiet" onClick={() => nav.syncOn()} style={{ color: "var(--bone-2)" }}>
              turn on
            </button>
            <button className="btn-quiet" onClick={() => setJoining(true)}>
              I have a sync code
            </button>
          </div>
        )}
        {error ? <p role="alert">{error}</p> : null}
      </>
    );
  }

  return (
    <section className="log-panel" aria-labelledby="log-devices">
      <div className="eyebrow" id="log-devices">On your other devices</div>
      {body}
      <div className="log-panel__actions" style={{ marginTop: 18 }}>
        <button className="btn-quiet" onClick={nav.exportLog} disabled={!hasLog}>
          download the log
        </button>
        <button className="btn-quiet" onClick={() => fileRef.current?.click()}>
          load a log file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) nav.importLog(file);
            event.target.value = "";
          }}
        />
      </div>
    </section>
  );
}

// "What En knows about you": the profile En inferred, with the evidence for
// each part, and a way to correct every part of it.
function ScreenKnows({ nav, knows, history, preferences, onChange, onToggleGenre, onRetry, mode, listSource, catchingUp }) {
  const list = knows.status === "ready" ? knows.list : null;
  const isList = Array.isArray(list);
  const profile = useMemo(() => (list ? buildTasteProfile({ malList: list, feedbackHistory: history }) : null), [list, history]);
  const evidence = useMemo(() => (isList ? describeGenreAffinity(list) : {}), [list, isList]);
  const bench = useMemo(() => (isList ? benchFor(list) : []), [list, isList]);
  const [adding, setAdding] = useState(false);
  const [notes, setNotes] = useState(preferences.notes);
  const [notesSaved, setNotesSaved] = useState(false);

  const { moreOf, notFavorite, notDisliked, mutedSeeds, excludedGenres } = preferences;
  const favorites = profile ? uniqueTitles([...moreOf, ...profile.favoriteGenres]).filter((genre) => !hasLabel(notFavorite, genre)) : [];
  const dislikes = profile ? profile.dislikedTropes.filter((trope) => !hasLabel(notDisliked, trope) && !hasLabel(moreOf, trope)) : [];
  const missing = GENRE_OPTIONS.filter((genre) => !hasLabel(favorites, genre));
  const site = mode === "username" ? sourceLabel(listSource) : "MyAnimeList";

  const rated = history.filter((entry) => entry.state === "rated");
  const good = rated.filter((entry) => entry.feedback === "good").length;
  const meh = rated.filter((entry) => entry.feedback === "meh");
  const passed = history.filter((entry) => entry.state === "skipped" || entry.state === "not_tonight").length;
  const tasteModel = useMemo(() => buildTasteModel(history, { ignored: preferences.unlearned }), [history, preferences.unlearned]);
  const traits = useMemo(() => describeModel(tasteModel), [tasteModel]);
  const rate = useMemo(() => hitRate(history), [history]);
  const stillToRead = history.filter(needsBackfill).length;

  function saveNotes() {
    if (notes.trim() === preferences.notes.trim()) return;
    onChange({ notes: notes.trim() });
    setNotesSaved(true);
  }

  function isMuted(entry) {
    return mutedSeeds.some((seed) => (seed.malId && seed.malId === entry.id) || (seed.anilistId && seed.anilistId === entry.anilistId));
  }

  function toggleMuted(entry) {
    onChange({
      mutedSeeds: isMuted(entry)
        ? mutedSeeds.filter((seed) => !((seed.malId && seed.malId === entry.id) || (seed.anilistId && seed.anilistId === entry.anilistId)))
        : [...mutedSeeds, { title: listTitle(entry), malId: entry.id || null, anilistId: entry.anilistId || null }]
    });
  }

  let summary = "";
  if (isList) {
    const finished = list.filter((entry) => entry.my_list_status?.status === "completed").length;
    const dropped = list.filter((entry) => entry.my_list_status?.status === "dropped").length;
    const average = profile?.scoreTendencies?.averageScore;
    summary = `Read from your ${site} list: ${formatCount(finished)} finished, ${formatCount(dropped)} dropped${average ? `, ${average} average score` : ""}.`;
  } else if (list) {
    summary = "Read from the shows you told En you love.";
  }
  if (summary && rated.length) summary += ` And from how ${rated.length === 1 ? "one of its picks" : `${rated.length} of its picks`} landed.`;

  return (
    <div className="app-frame">
      <Chrome onLog={nav.log} />
      <div className="app-stage" style={{ alignItems: "flex-start", paddingTop: 80 }}>
        <div className="column" style={{ maxWidth: 680 }}>
          <div className="eyebrow fade-up">What En knows</div>
          <h2 className="serif-display fade-up delay-1" style={{ fontSize: 48, margin: "24px 0 8px", fontWeight: 300 }}>
            About you
          </h2>
          <p className="fade-up delay-2" style={{ color: "var(--bone-3)", fontStyle: "italic", lineHeight: 1.6, maxWidth: 560 }}>
            {knows.status === "error"
              ? knows.error
              : knows.status === "ready"
                ? `${summary} If something here is wrong, change it. En reads this before every pick.`
                : "Reading your list…"}
          </p>
          {knows.status === "error" && (
            <button className="btn-quiet" onClick={onRetry}>
              try again
            </button>
          )}

          {profile && (
            <>
              <section className="knows-section fade-up delay-2" aria-labelledby="knows-favorites">
                <div className="eyebrow" id="knows-favorites">You keep coming back to</div>
                <p className="knows-section__lede">
                  {isList
                    ? "Genres you score above your own average. Pools lean toward them."
                    : "Genres from the shows you named. Pools lean toward them."}
                </p>
                {favorites.length ? (
                  favorites.map((genre) => {
                    const said = hasLabel(moreOf, genre);
                    return (
                      <div key={genre} className="knows-row">
                        <div>
                          <span className="knows-row__label">{genreLabel(genre)}</span>
                          <span className="meta knows-row__why">{said ? "you said so" : favoriteWhy(evidence[normalizeTitleForCompare(genre)], isList)}</span>
                        </div>
                        <button
                          className="btn-quiet"
                          onClick={() =>
                            onChange(
                              said
                                ? { moreOf: withoutLabel(moreOf, genre) }
                                : { notFavorite: [...notFavorite, genre], moreOf: withoutLabel(moreOf, genre) }
                            )
                          }
                        >
                          {said ? "remove" : "not really"}
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <p className="meta">Nothing yet. There isn't enough on the list to tell.</p>
                )}
                {notFavorite.length ? (
                  <p className="meta" style={{ marginTop: 16 }}>
                    You said these aren't you:{" "}
                    {notFavorite.map((genre, index) => (
                      <span key={genre}>
                        {index ? ", " : ""}
                        {genreLabel(genre)}{" "}
                        <button className="btn-quiet" style={{ padding: 0 }} onClick={() => onChange({ notFavorite: withoutLabel(notFavorite, genre) })}>
                          undo
                        </button>
                      </span>
                    ))}
                  </p>
                ) : null}
                <div style={{ marginTop: 18 }}>
                  {adding ? (
                    <div className="fade-in">
                      <div className="chips chips--left" role="group" aria-label="Genres En missed">
                        {missing.map((genre) => (
                          <button
                            key={genre}
                            className="chip"
                            onClick={() => onChange({ moreOf: [...moreOf, genre], notFavorite: withoutLabel(notFavorite, genre) })}
                          >
                            + {genre}
                          </button>
                        ))}
                      </div>
                      <button className="btn-quiet" onClick={() => setAdding(false)} style={{ marginTop: 10 }}>
                        done
                      </button>
                    </div>
                  ) : (
                    <button className="btn-quiet" onClick={() => setAdding(true)}>
                      + something En missed
                    </button>
                  )}
                </div>
              </section>

              <section className="knows-section" aria-labelledby="knows-dislikes">
                <div className="eyebrow" id="knows-dislikes">Doesn't land for you</div>
                <p className="knows-section__lede">What you drop or score below your average. En steers around it unless tonight asks for it.</p>
                {dislikes.length ? (
                  dislikes.map((trope) => (
                    <div key={trope} className="knows-row">
                      <div>
                        <span className="knows-row__label">{genreLabel(trope)}</span>
                        <span className="meta knows-row__why">{dislikeWhy(evidence[normalizeTitleForCompare(trope)])}</span>
                      </div>
                      <button className="btn-quiet" onClick={() => onChange({ notDisliked: [...notDisliked, trope] })}>
                        it's fine, actually
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="meta">Nothing stands out. You haven't turned away from any one genre.</p>
                )}
                {notDisliked.length ? (
                  <p className="meta" style={{ marginTop: 16 }}>
                    You said these are fine:{" "}
                    {notDisliked.map((trope, index) => (
                      <span key={trope}>
                        {index ? ", " : ""}
                        {genreLabel(trope)}{" "}
                        <button className="btn-quiet" style={{ padding: 0 }} onClick={() => onChange({ notDisliked: withoutLabel(notDisliked, trope) })}>
                          undo
                        </button>
                      </span>
                    ))}
                  </p>
                ) : null}
              </section>

              <section className="knows-section" aria-labelledby="knows-never">
                <div className="eyebrow" id="knows-never">Never suggest</div>
                <p className="knows-section__lede">
                  Left out of every pick, wherever it would come from. The same list sits under tonight's question.
                </p>
                <GenreChips excluded={excludedGenres} onToggle={onToggleGenre} align="left" />
                {excludedGenres.length ? (
                  <div className="log-panel__actions">
                    <button
                      className="btn-quiet"
                      onClick={(event) => {
                        const section = event.currentTarget.closest("section");
                        onChange({ excludedGenres: [] });
                        section?.querySelector(".chip")?.focus();
                      }}
                    >
                      clear all
                    </button>
                  </div>
                ) : null}
              </section>

              {bench.length ? (
                <section className="knows-section" aria-labelledby="knows-seeds">
                  <div className="eyebrow" id="knows-seeds">Where En starts looking</div>
                  <p className="knows-section__lede">
                    Your favorites. En's pools grow from what fans of these shows love. Take one out and it stops shaping your
                    picks. It stays on your list.
                  </p>
                  {bench.map((entry) => {
                    const muted = isMuted(entry);
                    const score = entry.my_list_status?.score;
                    return (
                      <div key={entry.anilistId || entry.id} className={muted ? "knows-row knows-row--muted" : "knows-row"}>
                        <div>
                          <span className="knows-row__label" style={{ fontStyle: "italic" }}>{listTitle(entry)}</span>
                          <span className="meta knows-row__why">{score ? `you gave it ${score}` : "finished recently"}</span>
                        </div>
                        <button className="btn-quiet" onClick={() => toggleMuted(entry)}>
                          {muted ? "start here again" : "don't start here"}
                        </button>
                      </div>
                    );
                  })}
                </section>
              ) : null}

              {history.length ? (
                <LearnedSection
                  tasteModel={tasteModel}
                  traits={traits}
                  rate={rate}
                  meh={meh}
                  passed={passed}
                  unlearned={preferences.unlearned}
                  onChange={onChange}
                  catchingUp={catchingUp}
                  stillToRead={stillToRead}
                />
              ) : null}

              <section className="knows-section" aria-labelledby="knows-notes" style={{ paddingBottom: 96 }}>
                <div className="eyebrow" id="knows-notes">In your own words</div>
                <p className="knows-section__lede">
                  Anything En should always keep in mind. It's read before every pick, and counts for more than anything En guessed.
                </p>
                <textarea
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                    setNotesSaved(false);
                  }}
                  onBlur={saveNotes}
                  maxLength={NOTES_LIMIT}
                  rows={3}
                  aria-label="Anything En should always keep in mind"
                  placeholder="no fan service; I like shows I can finish in a weekend"
                  className="knows-notes"
                />
                <div className="log-panel__actions" style={{ alignItems: "baseline" }}>
                  <button className="btn-quiet" onClick={saveNotes} disabled={notes.trim() === preferences.notes.trim()}>
                    save
                  </button>
                  <span className="meta" role="status">
                    {notesSaved && notes.trim() === preferences.notes.trim() ? "saved" : `${notes.length}/${NOTES_LIMIT}`}
                  </span>
                </div>
                <div style={{ marginTop: 72 }}>
                  <SuggestionNote />
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// En's answer -> the MyAnimeList change it asks for (api/mal-status.js).
const MAL_ACTION_FOR = { good: "good", meh: "meh", later: "later", watching: "tonight" };

const ROOM_POLL_MS = 3000;

// "What En has learned": its hit rate, and the traits behind hits and
// misses, each of which can be forgotten.
function LearnedSection({ tasteModel, traits, rate, meh, passed, unlearned, onChange, catchingUp, stillToRead }) {
  const answered = rate.all.length;
  const hits = rate.all.filter((pick) => pick.hit).length;
  const recentHits = rate.recent.filter((pick) => pick.hit).length;
  const firstHits = rate.first.filter((pick) => pick.hit).length;
  const lean =
    tasteModel.confidence < 0.35
      ? "En leans on this a little so far, and more with every answer."
      : tasteModel.confidence < 0.8
        ? "En leans on this more and more."
        : "En leans on this fully now.";
  const streak = rate.all.slice(-20);
  const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

  let lede;
  if (!answered) {
    lede = "En learns from every pick you answer: what lands, what doesn't, what you pass on. Nothing to go on yet.";
  } else {
    const tally = answered >= 15
      ? `${recentHits} of your last ${rate.recent.length} landed; ${firstHits} of your first ${rate.first.length} did.`
      : `${hits} of ${answered} landed so far.`;
    lede = `From ${answered} pick${answered === 1 ? "" : "s"} you've answered${passed ? `, and ${passed} passed over` : ""}. ${tally} ${lean}`;
  }

  const rows = (list, word) =>
    list.map((trait) => (
      <div key={trait.key} className="knows-row">
        <div>
          <span className="knows-row__label">{capital(trait.label)}</span>
          <span className="meta knows-row__why">
            {word === "landed" ? `${trait.hits} of ${trait.hits + trait.misses} landed` : `${trait.misses} of ${trait.hits + trait.misses} missed`}
          </span>
        </div>
        <button className="btn-quiet" onClick={() => onChange({ unlearned: [...unlearned, trait.key] })}>
          forget this
        </button>
      </div>
    ));

  return (
    <section className="knows-section" aria-labelledby="knows-learned">
      <div className="eyebrow" id="knows-learned">What En has learned</div>
      <p className="knows-section__lede">{lede}</p>
      {streak.length ? (
        <p className="hit-streak" role="img" aria-label={`${streak.filter((pick) => pick.hit).length} of the last ${streak.length} picks landed`}>
          {streak.map((pick) => (
            <span key={pick.id} className={pick.hit ? "hit-dot hit-dot--hit" : "hit-dot"} title={`${pick.title}: ${pick.hit ? "landed" : "missed"}`} />
          ))}
        </p>
      ) : null}
      {traits.landed.length ? (
        <>
          <p className="meta knows-learned__heading">Lands for you</p>
          {rows(traits.landed, "landed")}
        </>
      ) : null}
      {traits.missed.length ? (
        <>
          <p className="meta knows-learned__heading">Misses for you</p>
          {rows(traits.missed, "missed")}
        </>
      ) : null}
      {answered && !traits.landed.length && !traits.missed.length ? (
        <p className="meta">No pattern yet. One shows up once a few picks share something.</p>
      ) : null}
      {meh.filter((entry) => entry.feedback_note).slice(0, 4).map((entry) => (
        <p key={entry.id} className="meta" style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 15, margin: "8px 0" }}>
          {entry.recommendation.title}: “{entry.feedback_note}”
        </p>
      ))}
      <p className="meta" role="status" style={{ marginTop: 16 }}>
        {catchingUp
          ? "Reading your past picks, so they count too…"
          : stillToRead
            ? `${stillToRead} past pick${stillToRead === 1 ? "" : "s"} still to read; En catches up on them next time.`
            : answered
              ? "Every past pick counts, not just new ones."
              : ""}
      </p>
      {unlearned.length ? (
        <button className="btn-quiet" onClick={() => onChange({ unlearned: [] })}>
          En forgot {unlearned.length} thing{unlearned.length === 1 ? "" : "s"} you asked it to · bring them back
        </button>
      ) : null}
    </section>
  );
}

const MAL_STATUS_NAMES = {
  watching: "watching",
  completed: "completed",
  plan_to_watch: "plan to watch",
  on_hold: "on hold",
  dropped: "dropped"
};

const MAL_STATUS_WORDS = {
  watching: "marked as watching",
  plan_to_watch: "added to plan to watch",
  completed: "marked as completed"
};

// The favorites seeds come from, best first, without repeats.
function benchFor(list) {
  const { by, favorites, recentGood } = seedBench(list);
  const seen = new Set();
  return [...recentGood.slice(0, 3), ...favorites]
    .filter((entry) => {
      const id = by === "anilistId" ? entry.anilistId : entry.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, 12);
}

function listTitle(entry) {
  return entry.alternative_titles?.en || entry.title;
}

function hasLabel(list, label) {
  const key = normalizeTitleForCompare(label);
  return list.some((item) => normalizeTitleForCompare(item) === key);
}

function withoutLabel(list, label) {
  const key = normalizeTitleForCompare(label);
  return list.filter((item) => normalizeTitleForCompare(item) !== key);
}

// Catalog labels come lowercase and hyphenated ("slice-of-life"); show the
// proper name where there is one.
function genreLabel(label) {
  const text = String(label || "");
  const known = EXCLUDABLE.find((option) => normalizeTitleForCompare(option.label) === normalizeTitleForCompare(text));
  if (known) return known.label;
  if (text !== text.toLowerCase()) return text;
  const spaced = text.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function favoriteWhy(stat, fromList) {
  if (!stat) return fromList ? "common to the shows you loved" : "from the shows you named";
  const parts = [`${stat.count} of your shows`];
  if (stat.scoreDelta > 0) parts.push(`scored ${stat.scoreDelta.toFixed(1)} above your average`);
  return parts.join(" · ");
}

function dislikeWhy(stat) {
  if (!stat) return "from what you said about En's picks";
  const parts = [];
  if (stat.dropped) parts.push(`dropped ${stat.dropped} of ${stat.count}`);
  if (stat.scoreDelta < 0) parts.push(`scored ${Math.abs(stat.scoreDelta).toFixed(1)} below your average`);
  return parts.join(" · ") || `${stat.count} of your shows`;
}

function joinList(items) {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function formatTimeAgo(date) {
  const minutes = Math.round((Date.now() - Date.parse(date)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return formatDate(date);
}

// Cross-fading screens is a nicety: only where the browser has it, the tab
// is visible, and the user hasn't asked for less motion.
function canAnimateScreens() {
  return (
    typeof document.startViewTransition === "function" &&
    document.visibilityState === "visible" &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

// The way in the user chose last, if it's still set up; otherwise MAL login,
// then a username, then a typed list.
function initialMode() {
  const available = {
    mal: Boolean(loadTokens()?.access_token),
    username: Boolean(loadListSource()),
    manual: Boolean(loadManualList().trim())
  };
  const saved = loadActiveMode();
  if (available[saved]) return saved;
  return available.mal ? "mal" : available.username ? "username" : available.manual ? "manual" : "mal";
}

function partnerName(partner) {
  return partner?.kind === "mal" ? partner.username : partner?.name?.trim() || "them";
}

function possessive(name) {
  return name === "them" ? "their" : `${name}'s`;
}

function readSession(key) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeSession(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // storage unavailable (private mode); the draft just won't survive a reload
  }
}

function formatCount(count) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(count);
}

function makeUserReflection(feedback, note) {
  const cleaned = stripMarkdown(note).trim().toLowerCase();
  if (cleaned) {
    return cleaned.endsWith(".") ? cleaned : `${cleaned}.`;
  }

  if (feedback === "good") {
    const options = ["stayed with me.", "en was right.", "needed that one."];
    return options[Math.floor(Math.random() * options.length)];
  }

  const mehOptions = ["didn't quite meet me.", "not tonight.", "missed the feeling."];
  return mehOptions[Math.floor(Math.random() * mehOptions.length)];
}

function hasRecommendationInput() {
  return Boolean(loadTokens()?.access_token || loadListSource() || loadManualList().trim());
}

// Retries the model up to MAX_RECOMMENDATION_ATTEMPTS times, telling it why
// its previous answer was rejected. Configuration errors (no API key) are
// rethrown straight away instead of being papered over by a fallback.
async function askUntilValid({ label, ask, validate }) {
  let previousAttemptRejected;
  const failures = [];

  for (let attempt = 1; attempt <= MAX_RECOMMENDATION_ATTEMPTS; attempt += 1) {
    try {
      const answer = await ask(previousAttemptRejected);
      const validation = validate(answer);
      debugLog(`[En debug] returned ${label} validation`, { attempt, answer, validation });
      if (validation.ok) {
        return { answer, validation };
      }
      failures.push(`attempt ${attempt}: rejected "${answer?.title || ""}" - ${validation.error}`);
      previousAttemptRejected = { title: answer?.title || "", reason: validation.error };
    } catch (error) {
      if (isEnConfigError(error)) throw error;
      failures.push(`attempt ${attempt}: ${error.message}`);
      console.warn(`[En debug] ${label} attempt failed`, { attempt, error });
    }
  }

  console.warn(`[En] ${label} fell back after ${MAX_RECOMMENDATION_ATTEMPTS} attempts:\n${failures.join("\n")}`);
  return null;
}

async function askForAllowedRecommendation({ mood, signals, candidateList, memory, unwatchedTitles, ask = askEn, label = "recommendation" }) {
  const modelCandidates = candidateList.map(toModelCandidate);
  const result = await askUntilValid({
    label,
    ask: (previousAttemptRejected) =>
      ask({ mood, ...signals, candidateList: modelCandidates, previousAttemptRejected }),
    validate: (recommendation) => validateRecommendation(recommendation, candidateList, memory, unwatchedTitles)
  });

  return result
    ? mergeCandidateMeta(result.answer, result.validation.candidate)
    : deterministicRecommendation(candidateList);
}

async function askForAllowedChoice({ queriedTitles, queriedTitleHistory, mood, signals }) {
  const result = await askUntilValid({
    label: "choice",
    ask: (previousAttemptRejected) =>
      askEnChoose({ queriedTitles, queriedTitleHistory, mood, ...signals, previousAttemptRejected }),
    validate: (choice) => validateChoice(choice, queriedTitles)
  });
  if (result) return result.answer;

  const fallbackTitle = queriedTitles[0];
  const resolvedMeta = await resolveAnimeMetadata(fallbackTitle, fallbackTitle);
  return {
    title: fallbackTitle,
    title_jp: resolvedMeta?.title_jp || fallbackTitle,
    year: resolvedMeta?.year || new Date().getFullYear(),
    episodes: resolvedMeta?.episodes || 12,
    genre: resolvedMeta?.genre || "",
    reason: "En couldn't settle this cleanly. Going with the first one you named.",
    log_line: "Ties go to whoever spoke first.",
    fallback: true
  };
}

function validateChoice(choice, queriedTitles) {
  const required = ["title", "title_jp", "year", "episodes", "genre", "reason", "log_line"];
  const missing = required.find((key) => choice?.[key] === undefined || choice?.[key] === null || choice?.[key] === "");
  if (missing) {
    return { ok: false, error: `missing ${missing}` };
  }

  if (findQueriedIndex(choice, queriedTitles) < 0) {
    return { ok: false, error: "the chosen title must be one of queriedTitles, written exactly as given" };
  }

  return { ok: true };
}

function findQueriedIndex(pick, queriedTitles) {
  const keys = [pick?.title, pick?.title_jp].map(normalizeTitleForCompare).filter(Boolean);
  return queriedTitles.findIndex((queried) => keys.includes(normalizeTitleForCompare(queried)));
}

function applyResolvedMeta(pick, meta) {
  if (!meta) return pick;
  return {
    ...pick,
    title: meta.title,
    title_jp: meta.title_jp || meta.title,
    year: meta.year ?? pick.year,
    episodes: meta.episodes ?? pick.episodes,
    genre: meta.genre || pick.genre,
    image_url: meta.image_url || pick.image_url || "",
    watch_links: meta.watch_links?.length ? meta.watch_links : pick.watch_links || [],
    // Lets the pick be excluded by id later, and updated on MAL.
    ...(meta.anilistId ? { anilistId: meta.anilistId } : {}),
    ...(meta.malId ? { malId: meta.malId } : {})
  };
}

// AniList covers come with the metadata; MAL search is only needed for
// catalog picks that don't have one.
async function withImage(pick, aliases = []) {
  if (pick.image_url) return pick;
  const imageUrl = await fetchAnimeImage(pick.title, aliases);
  return { ...pick, image_url: imageUrl || "" };
}

function matchCatalogAnime(title, titleJp) {
  return ANIME_CATALOG.find(
    (anime) => titleMatchesAnime(title, anime) || titleMatchesAnime(titleJp, anime)
  );
}

// Local catalog is checked first (free, instant, hand-verified metadata) and
// treated as the trusted authority when a title happens to be one of the 90
// curated entries. AniList is the fallback for everything else - it's what
// makes existence-validation and metadata work across a user's full history
// instead of only the tiny local pool. AniList failures (offline, rate
// limited, timed out) resolve to null here rather than throwing, so callers
// always have a well-defined "couldn't confirm it" path to fall back to.
async function resolveAnimeMetadata(title, titleJp) {
  const localMatch = matchCatalogAnime(title, titleJp);
  if (localMatch) {
    return {
      source: "catalog",
      title: localMatch.title,
      title_jp: localMatch.title_jp || localMatch.title,
      year: localMatch.year,
      episodes: localMatch.episodes,
      genre: localMatch.genre,
      image_url: ""
    };
  }

  const aniListMatch =
    (await resolveAnimeOnAniList(title)) ||
    (titleJp && titleJp !== title ? await resolveAnimeOnAniList(titleJp) : null);

  return aniListMatch ? { source: "anilist", ...aniListMatch } : null;
}

async function askForAllowedVerdict({
  queriedTitles,
  queriedTitleHistory,
  mood,
  signals,
  candidateList,
  memory
}) {
  const modelCandidates = candidateList.map(toModelCandidate);
  const result = await askUntilValid({
    label: "verdict",
    ask: (previousAttemptRejected) =>
      askEnVerdict({ queriedTitles, queriedTitleHistory, mood, ...signals, candidateList: modelCandidates, previousAttemptRejected }),
    validate: (verdict) => validateVerdict(verdict, queriedTitles, candidateList, memory)
  });

  // Failing to reach the model used to come back as a "no" plus a random
  // catalog pick, i.e. En vetoed the user's title because it couldn't think.
  if (!result) {
    throw new Error("En couldn't weigh that one right now. Try again in a moment.");
  }

  const { answer, validation } = result;
  return validation.candidate ? mergeCandidateMeta(answer, validation.candidate) : answer;
}

function validateVerdict(verdict, queriedTitles, candidateList, memory) {
  const required = ["verdict", "queried_title", "title", "title_jp", "year", "episodes", "genre", "reason", "log_line"];
  const missing = required.find((key) => verdict?.[key] === undefined || verdict?.[key] === null || verdict?.[key] === "");
  if (missing) {
    return { ok: false, error: `missing ${missing}` };
  }

  if (verdict.verdict !== "yes" && verdict.verdict !== "no") {
    return { ok: false, error: "invalid verdict value" };
  }

  if (verdict.verdict === "yes") {
    return { ok: true };
  }

  if (titleMatchesAnyQueried(verdict.title, queriedTitles) || titleMatchesAnyQueried(verdict.title_jp, queriedTitles)) {
    return { ok: false, error: "the alternative repeats the queried title" };
  }

  if (isMemoryExcludedTitle(verdict.title, memory) || isMemoryExcludedTitle(verdict.title_jp, memory)) {
    return { ok: false, error: "the alternative is already on the user's list or was recommended before" };
  }

  // The alternative has to come from the candidate pool, so it can't be a
  // hallucinated or unvetted title.
  const candidate = findCandidateByRecommendation(verdict, candidateList);
  if (!candidate) {
    return { ok: false, error: "the alternative must exactly match a candidateList title" };
  }

  return { ok: true, candidate };
}

function titleMatchesAnyQueried(title, queriedTitles) {
  const normalized = normalizeTitleForCompare(title);
  return Boolean(normalized) && queriedTitles.some((queried) => normalizeTitleForCompare(queried) === normalized);
}

// Explicit separators (new lines, ";", "vs", "or", " / ") win over commas, so
// "So I'm a Spider, So What? vs Frieren" stays two titles, not three. Capped
// at four, which is what the choose prompt handles.
function splitShortlist(text) {
  const explicit = /[\n;]+|\s\/\s|\bvs\.?(?=\s|$)|\bor\b/i;
  return text
    .split(explicit.test(text) ? new RegExp(explicit.source, "gi") : /,+/)
    .map((title) => title.trim())
    .filter(Boolean)
    .slice(0, 4);
}

// Enter submits a one-line answer (Shift+Enter adds a line). List fields use
// Ctrl/Cmd+Enter because new lines separate titles there. Never fires while
// an IME is composing, or confirming Japanese input would submit.
function submitOnEnter(onSubmit, { requireModifier = false } = {}) {
  return (event) => {
    // Safari reports the composition-ending Enter as keyCode 229 instead.
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (requireModifier ? !(event.ctrlKey || event.metaKey) : event.shiftKey) return;
    event.preventDefault();
    onSubmit();
  };
}

function countStatuses(list) {
  return list.reduce((counts, anime) => {
    const status = anime.my_list_status?.status || "missing";
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function validateRecommendation(recommendation, candidateList, memory, unwatchedTitles) {
  const required = ["title", "title_jp", "year", "episodes", "genre", "reason", "log_line"];
  const missing = required.find((key) => recommendation?.[key] === undefined || recommendation?.[key] === null || recommendation?.[key] === "");
  if (missing) {
    return { ok: false, error: `missing ${missing}` };
  }

  const candidate = findCandidateByRecommendation(recommendation, candidateList);
  if (!candidate) {
    return { ok: false, error: "that title isn't in candidateList; pick one that is" };
  }

  if (!candidate.resume && (isMemoryExcludedTitle(recommendation.title, memory) || isMemoryExcludedTitle(recommendation.title_jp, memory))) {
    return { ok: false, error: "that title is already on the user's list or was recommended before" };
  }

  const blockedEvidenceTitle = findBlockedEvidenceTitle(
    `${recommendation.reason} ${recommendation.log_line}`,
    unwatchedTitles
  );
  if (blockedEvidenceTitle) {
    return {
      ok: false,
      error: `the reason cites ${blockedEvidenceTitle}, which the user hasn't watched yet; don't use it as evidence`
    };
  }

  return { ok: true, candidate };
}

function mergeCandidateMeta(recommendation, candidate) {
  return {
    ...recommendation,
    title: candidate.title,
    title_jp: candidate.title_jp || recommendation.title_jp || candidate.title,
    year: candidate.year,
    episodes: candidate.episodes,
    genre: candidate.genre,
    image_url: candidate.image_url || recommendation.image_url || "",
    watch_links: candidate.watchLinks || [],
    // What the pick was, for En to learn from how it lands (learning.js).
    features: featuresOf(candidate),
    // Saved with the pick so later pools can exclude it by id, not just name.
    ...(candidate.resume ? { resume: candidate.resume } : {}),
    ...(candidate.anilistId ? { anilistId: candidate.anilistId } : {}),
    ...(candidate.malId ? { malId: candidate.malId } : {})
  };
}

function countMemory(memory) {
  return Object.fromEntries(
    Object.entries(memory).map(([bucket, titles]) => [bucket, titles.length])
  );
}

function formatAnimeMeta(pick) {
  const parts = [pick.year];

  if (pick.episodes === 1) {
    parts.push("film");
  } else if (pick.episodes) {
    parts.push(`${pick.episodes} episodes`);
  }

  if (pick.genre) {
    parts.push(pick.genre);
  }

  return parts.filter(Boolean).join(" · ");
}

function formatJapaneseDate(date) {
  const numerals = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const year = String(date.getFullYear())
    .split("")
    .map((digit) => numerals[Number(digit)])
    .join("");
  return `${year}年${toJapaneseNumber(date.getMonth() + 1)}月${toJapaneseNumber(date.getDate())}日`;
}

function toJapaneseNumber(value) {
  const numerals = ["〇", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value <= 10) {
    return value === 10 ? "十" : numerals[value];
  }
  if (value < 20) {
    return `十${value % 10 ? numerals[value % 10] : ""}`;
  }
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${numerals[tens]}十${ones ? numerals[ones] : ""}`;
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`>#]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    weekday: "long"
  }).format(new Date(date));
}
