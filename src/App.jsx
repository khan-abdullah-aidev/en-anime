import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { askEn, askEnChoose, askEnTogether, askEnVerdict } from "./openrouter.js";
import { isEnConfigError } from "./llmProviders.js";
import { beginMalOauth, finishMalOauth, refreshMalOauth } from "./oauth.js";
import { MalAuthError, fetchAnimeImage, fetchAnimeList, fetchPartnerList, isMalAuthError } from "./mal.js";
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
  loadTasteProfileCache,
  loadTokens,
  recordRecommendedAnime,
  saveManualList,
  savePartner,
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
  summarizeRecentPatterns
} from "./tasteProfile.js";
import { answersFromList, buildWatchHistoryDigest, describeQueriedTitle } from "./watchHistory.js";
import { buildOpenCandidatePool, buildTogetherPool, toModelCandidate } from "./discovery.js";
import { normalizeTitleForCompare, titleMatchesAnime } from "./titleUtils.js";
import { resolveAnimeOnAniList } from "./anilist.js";
import { PARENT, VIEW, parsePath, pathFor } from "./routes.js";
import { debugLog } from "./debug.js";

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
  const { view, entryId, titles } = target || {};

  // A request can't survive a reload or back/forward; land where it started.
  if (!view || view === VIEW.THINKING) return home();
  // Returning visitors skip the landing page, MAL or manual list alike.
  if (view === VIEW.LANDING) return initial && hasInput ? home() : { view };
  if (view === VIEW.REVEAL || view === VIEW.FEEDBACK) {
    return loadHistory().some((entry) => entry.id === entryId) ? { view, entryId } : { view: VIEW.HISTORY };
  }
  if (view === VIEW.HISTORY || view === VIEW.MANUAL) return { view };
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
function writeHistory(method, { view, entryId = null, titles }) {
  const currentIdx = window.history.state?.idx ?? 0;
  const idx = method === "push" ? currentIdx + 1 : currentIdx;
  const url = view === VIEW.THINKING ? window.location.pathname : pathFor(view, entryId);
  const state = { view, entryId, ...(titles ? { titles } : {}), idx };
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
  const [mode, setMode] = useState(() => (loadTokens()?.access_token ? "mal" : loadManualList() ? "manual" : "mal"));
  const [malList, setMalList] = useState([]);
  const [pendingReviewIds, setPendingReviewIds] = useState([]);
  const [status, setStatus] = useState("");
  const [thinkingMood, setThinkingMood] = useState("");
  const [error, setError] = useState("");
  const handledCallback = useRef(false);
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
      showRoute(route, window.history.state?.idx ?? 0);
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
    if (!tokens?.access_token || !loadHistory().some(isAwaitingAnswer)) return;
    fetchAnimeListWithRefresh()
      .then(applyListAnswers)
      .catch(() => {
        // Not worth an error here; the next request will surface it.
      });
  }, []);

  useEffect(() => {
    if (window.location.pathname !== "/callback" || handledCallback.current) return;

    handledCallback.current = true;
    setStatus("Receiving the thread from MyAnimeList");
    finishMalOauth(window.location.href)
      .then((nextTokens) => {
        setTokens(nextTokens);
        setMode("mal");
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
  function go(nextView, { replace = false, entryId = null, titles } = {}) {
    setError("");
    if (nextView !== VIEW.THINKING) activeRequest.current += 1;
    const route = { view: nextView, entryId, titles };
    showRoute(route, writeHistory(replace ? "replace" : "push", route));
  }

  function showRoute({ view: nextView, entryId, titles }, idx) {
    if (entryId) setRevealEntryId(entryId);
    if (titles) setShortlistTitles(titles);
    setRouteIdx(idx);
    setView(nextView);
  }

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
    setMode("manual");
    goHome();
  }

  function canAskEn() {
    return hasRecommendationInput() && (mode === "manual" || Boolean(tokens?.access_token));
  }

  // Returns an id for the request; anything it does after an await checks
  // isCurrent(id) first, because the user may have navigated away meanwhile.
  function beginThinking(moodText, { replace = false } = {}) {
    passOverUnanswered();
    setStatus(mode === "manual" ? "Reading what you told En" : "Reading your history");
    setThinkingMood(moodText || "");
    go(VIEW.THINKING, { replace });
    activeRequest.current += 1;
    return activeRequest.current;
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
    const answers = answersFromList({ list, history: loadHistory() });
    if (!answers.length) return;
    const byId = new Map(loadHistory().map((entry) => [entry.id, entry]));
    for (const { id, answer, reflection } of answers) {
      const entry = byId.get(id);
      if (entry) answerEntry(entry, answer, { reflection });
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
    const list = mode === "manual" ? manualList : await fetchAnimeListWithRefresh();
    setMalList(Array.isArray(list) ? list : []);
    applyListAnswers(list);
    const history = loadHistory();

    const tasteProfile = buildTasteProfile({
      malList: list,
      feedbackHistory: history,
      previousProfile: loadTasteProfileCache()
    });
    saveTasteProfileCache(tasteProfile);

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
      unwatchedTitles: buildUnwatchedTitles({ malList: list, history }),
      signals: {
        watchHistory: buildWatchHistoryDigest(list),
        tasteProfile,
        recentPatterns: summarizeRecentPatterns(list, history),
        feedbackHistory: compactFeedbackHistory(history)
      }
    };
  }

  // Candidates from all of AniList (see discovery.js), or the curated
  // catalog if AniList can't be reached.
  async function findCandidates({ mood, list, signals, memory, partner: other }) {
    const passedOver = passedOverTonight();
    const { candidates, source, constraints, constraintsRelaxed } = other
      ? await buildTogetherPool({
          mood,
          passedOver,
          you: { list, history: loadHistory(), memory, tasteProfile: signals.tasteProfile },
          partner: other,
          recentPatterns: signals.recentPatterns
        })
      : await buildOpenCandidatePool({
          mood,
          passedOver,
          list,
          history: loadHistory(),
          tasteProfile: signals.tasteProfile,
          recentPatterns: signals.recentPatterns,
          memory
        });
    debugLog("[En debug] candidate pool", { source, count: candidates.length, constraints, constraintsRelaxed });
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
    try {
      const { list, signals, memory, unwatchedTitles } = await loadEnContext();
      say("Looking through everything you haven't seen");
      const { candidates: candidateList, steering } = await findCandidates({ mood: nextMood, list, signals, memory });
      say("Listening to tonight");

      const rec = await askForAllowedRecommendation({ mood: nextMood, signals: { ...signals, ...steering }, candidateList, memory, unwatchedTitles });
      const pick = await withImage(rec, [rec.title_jp]);
      revealPick(requestId, pick, { mood: nextMood || "Surprise me", request_mood: nextMood });
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
    try {
      const { list, signals, memory, unwatchedTitles } = await loadEnContext();
      say(`Reading ${possessive(name)} list`);
      const partnerList = await loadPartnerList(who);
      const partnerTaste = buildTasteProfile({ malList: partnerList, feedbackHistory: [] });
      say("Looking for something you'd both like");
      const { candidates: candidateList, steering } = await findCandidates({
        mood: moodText,
        list,
        signals,
        memory,
        partner: { list: partnerList, tasteProfile: partnerTaste }
      });
      say("Listening to tonight");

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
    try {
      const { list, memory, signals } = await loadEnContext();
      say("Weighing it against your history");
      const queriedTitles = [text];
      const [queriedTitleHistory, { candidates: candidateList, steering }] = await Promise.all([
        describeQueriedTitles(queriedTitles, list),
        findCandidates({ mood: moodText, list, signals, memory })
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
    setMode(manualList.trim() ? "manual" : "mal");
    setMalList([]);
    malListCache.current = null;
  }

  // Applies a "how was it?" answer to a logged pick: from the return-visit
  // question, the log, or a reopened pick.
  function answerEntry(entry, answer, { note = "", seenBefore = false, reflection = "", reason = "" } = {}) {
    let patch;
    if (answer === "not-tonight") {
      patch = {
        feedback: "",
        feedback_note: "",
        state: "not_tonight",
        not_tonight_at: new Date().toISOString(),
        pass_reason: reason,
        note: reason ? `not tonight · ${reason}.` : "not tonight."
      };
    } else if (answer === "later") {
      patch = { feedback: "", feedback_note: "", state: "pending", note: "waiting in the watchlist" };
    } else if (answer === "pass") {
      patch = { feedback: "", feedback_note: "", state: "skipped", note: "passed on it." };
    } else {
      patch = {
        feedback: answer,
        state: "rated",
        feedback_note: note.trim(),
        note: reflection || makeUserReflection(answer, note),
        ...(reflection ? { answered_from: "myanimelist" } : {}),
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
    return nextHistory;
  }

  function handleSaveForLater() {
    if (revealEntry) answerEntry(revealEntry, "later");
  }

  // "I've already seen it": keep how it landed as a taste signal, then ask
  // again with the mood that produced this pick (the title is already banned).
  function handleWatchTonight() {
    if (revealEntry) setHistory(updateHistoryEntry(revealEntry.id, { watch_tonight: true }));
  }

  // "Not tonight": log why, then ask again with the same mood. The reason
  // steers the next pick ("too long" -> shorter, "too heavy" -> lighter).
  function handleNotTonight(reason) {
    if (!revealEntry) return;
    answerEntry(revealEntry, "not-tonight", { reason });
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

    const remainingPendingIds = reviewIds.filter((id) => id !== pending.id);

    // Answered questions are replaced rather than stacked, so "back" from the
    // mood screen doesn't walk back through them.
    if (answer === "not-yet") {
      // An unanswered pick they still mean to watch becomes a saved one.
      if (pending.state === "unrated") {
        answerEntry(pending, "later");
      }
      setPendingReviewIds(remainingPendingIds);
      go(remainingPendingIds.length ? VIEW.PENDING : VIEW.MOOD, { replace: true });
      return;
    }

    const nextHistory = answerEntry(pending, answer);
    const nextPendingIds = remainingPendingIds.filter((id) =>
      nextHistory.some((entry) => entry.id === id && isAwaitingAnswer(entry))
    );
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
    disconnect: handleDisconnect
  };

  // A pick handed over in this visit and not yet answered gets the "watch it
  // tonight" actions; a reopened older pick shows how it went instead.
  const isNewPick = Boolean(revealEntry) && sessionEntryIds.current.has(revealEntry.id) && revealEntry.state === "unrated";
  // "I've already seen it" only makes sense when En chose the title; in
  // verdict/choose mode the user named it themselves.
  const canMarkSeen = isNewPick && !revealEntry.mode;
  // "Not tonight" re-asks the same question, which works for En's own picks
  // and for picks for two.
  const canPassTonight = isNewPick && (!revealEntry.mode || revealEntry.mode === "together");

  return (
    <NavContext.Provider value={nav}>
      <div style={{ minHeight: "100vh", position: "relative" }}>
        {error ? <ErrorRibbon message={error} onDismiss={() => setError("")} /> : null}
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
        {view === VIEW.TOGETHER && (
          <ScreenTogether
            key={partner ? partnerName(partner) : "new"}
            onLog={nav.log}
            partner={partner}
            checking={checkingPartner}
            onSubmit={handlePartnerSubmit}
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
          />
        )}
        {view === VIEW.THINKING && (
          <ScreenThinking
            onLog={nav.log}
            status={status}
            mood={thinkingMood}
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
            source={mode === "manual" || !tokens?.access_token ? "manual" : "mal"}
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
              className="serif-display"
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
            <hr className="hairline" style={{ marginTop: 8 }} />
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
            {pending.mode === "together"
              ? `Did you and ${pending.partner_name || "them"} watch ${pending.recommendation.title}?`
              : `Did you watch ${pending.recommendation.title}?`}
          </h2>
          <p className="meta fade-up delay-1">
            {pending.state === "pending" ? "Saved" : "En picked it"} · {formatDate(pending.date)}
          </p>

          <div className="choice-links fade-up delay-2" style={{ marginTop: 64 }}>
            <button className="btn-link" onClick={() => nav.pendingAnswer("good")}>
              It was good
            </button>
            <button className="btn-link" onClick={() => nav.pendingAnswer("meh")}>
              Meh
            </button>
            <button className="btn-link" onClick={() => nav.pendingAnswer("not-yet")}>
              Not yet
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

function ScreenMood({ onLog, onConsider, onSurprise, onShortlist, onTogether, mood, setMood }) {
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
              className="serif-display"
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
            <hr className="hairline" style={{ marginTop: 8 }} />
            {!mood && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  pointerEvents: "none",
                  paddingTop: 6
                }}
              >
                <span
                  key={hintIdx}
                  className="serif-display fade-in"
                  style={{
                    fontSize: 28,
                    color: "var(--bone-4)",
                    fontStyle: "italic",
                    fontWeight: 300
                  }}
                >
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
              className="serif-display"
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
            <hr className="hairline" style={{ marginTop: 8 }} />
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
              className="serif-display"
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
            <hr className="hairline" style={{ marginTop: 8 }} />
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

// "For two", step one: whose list to read alongside the user's.
function ScreenTogether({ onLog, partner, checking, onSubmit }) {
  const [kind, setKind] = useState(partner?.kind || "mal");
  const [username, setUsername] = useState(partner?.kind === "mal" ? partner.username : "");
  const [name, setName] = useState(partner?.kind === "manual" ? partner.name : "");
  const [list, setList] = useState(partner?.kind === "manual" ? partner.list : "");
  const ref = useRef(null);
  const ready = !checking && (kind === "mal" ? username.trim() : list.trim());
  const submit = () => ready && onSubmit({ kind, username, name, list });

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
              : "What they've seen and loved, and what to call them."}
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
            ) : (
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
                  className="serif-display"
                  placeholder="Frieren, Mushishi, Your Name..."
                  style={{ width: "100%", fontSize: 24, textAlign: "center", lineHeight: 1.4, color: "var(--bone)", resize: "none", fontWeight: 300, marginTop: 28 }}
                />
                <hr className="hairline" style={{ marginTop: 8 }} />
              </>
            )}
          </div>

          <div className="fade-up delay-4" style={{ marginTop: 64 }}>
            <button className="btn-link" onClick={submit} disabled={!ready} style={{ transition: "opacity 0.4s ease" }}>
              {checking ? "Reading their list…" : "Continue"}
            </button>
            <div style={{ marginTop: 20 }}>
              <button className="btn-quiet" onClick={() => setKind(kind === "mal" ? "manual" : "mal")}>
                {kind === "mal" ? "or — type what they've loved instead" : "or — use their MyAnimeList"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// "For two", step two: tonight's mood, for both of them.
function ScreenTogetherMood({ onLog, name, mood, setMood, onSubmit, onSurprise, onChangePartner }) {
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
              className="serif-display"
              placeholder="something we'll both talk about after"
              style={{ width: "100%", fontSize: 26, textAlign: "center", lineHeight: 1.4, color: "var(--bone)", resize: "none", fontWeight: 300 }}
            />
            <hr className="hairline" style={{ marginTop: 8 }} />
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
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenThinking({ onLog, status, mood, watchedCount, mode }) {
  const [phase, setPhase] = useState(0);
  const lines = useMemo(() => {
    const sourceLine = mode === "manual" ? "Reading what you told En" : "Reading your history";
    const listLine = watchedCount ? `${formatCount(watchedCount)} titles` : "Your list is opening";
    const moodLine = mood ? "Listening to tonight" : "Letting tonight choose itself";
    const baseLines = mode === "manual" ? [sourceLine, moodLine] : [sourceLine, listLine, moodLine];
    const finalLine = status && !baseLines.includes(status) ? status : "Considering";

    return [...baseLines, finalLine];
  }, [mode, mood, status, watchedCount]);

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
          <div className="breathe" style={{ marginBottom: 64 }}>
            <span className="dot" style={{ width: 8, height: 8 }}></span>
          </div>

          <div style={{ minHeight: 140 }}>
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
            {pick.watch_links?.length ? (
              <p className="meta watch-links">
                <span title="From AniList; availability varies by region">streams on</span>
                {pick.watch_links.map((link) => (
                  <a key={link.site} href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.site}
                  </a>
                ))}
              </p>
            ) : null}
          </div>

          <div className="reveal-scroll__copy ink-bloom delay-3">
            <div className="eyebrow shu">
              {pick.mode === "together"
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

const ANSWERS = ["good", "meh", "pass"];

function currentAnswer(entry) {
  return entry.state === "skipped" ? "pass" : entry.feedback || "";
}

function AnswerControls({ entry, onAnswer, prompt }) {
  const current = currentAnswer(entry);
  return (
    <div className="answer-controls">
      <span className="meta answer-controls__prompt">{prompt}</span>
      {ANSWERS.map((answer) => (
        <button
          key={answer}
          className={current === answer ? "btn-quiet answer-current" : "btn-quiet"}
          aria-pressed={current === answer}
          onClick={() => onAnswer(entry.id, answer)}
        >
          {answer}
        </button>
      ))}
    </div>
  );
}

// A pick reopened from the log: how it went, and a way to change that.
function PastPickAnswer({ entry, onAnswer }) {
  const [changing, setChanging] = useState(false);
  const summary =
    entry.state === "pending"
      ? "Saved for later."
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

function ScreenHistory({ nav, history, source }) {
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
              <button className="btn-quiet" onClick={nav.disconnect}>
                disconnect MyAnimeList
              </button>
            ) : (
              <>
                <button className="btn-quiet" onClick={nav.editManualList}>
                  edit your list
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
                  animationDelay: `${0.3 + i * 0.18}s`,
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
                      color: entry.feedback === "good" || entry.state === "pending"
                        ? "var(--shu)"
                        : "var(--bone-4)"
                    }}
                  >
                    {entry.state === "pending"
                      ? "○ pending"
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
                  {entry.mode === "together" && (
                    <div
                      className="meta"
                      style={{ marginTop: 10, fontSize: 9.5, letterSpacing: "0.16em", color: "var(--bone-4)" }}
                    >
                      for two · with {entry.partner_name || "them"}
                    </div>
                  )}
                  {entry.answered_from === "myanimelist" && (
                    <div
                      className="meta"
                      style={{ marginTop: 10, fontSize: 9.5, letterSpacing: "0.16em", color: "var(--bone-4)" }}
                    >
                      from MyAnimeList
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

          <div style={{ textAlign: "center", marginTop: 80, paddingBottom: 80 }}>
            <p
              className="meta"
              style={{ fontStyle: "italic", fontFamily: "var(--serif)", fontSize: 14 }}
            >
              — and that is all, for now.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
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

function isAwaitingAnswer(entry) {
  return entry.state === "pending" || entry.state === "unrated";
}

function findCurrentPending(history, pendingReviewIds, sessionIds) {
  const pendingById = new Map(
    history
      .filter(isAwaitingAnswer)
      .map((entry) => [entry.id, entry])
  );
  return pendingReviewIds.map((id) => pendingById.get(id)).find(Boolean) || findReviewEntries(history, sessionIds)[0];
}

// Saved picks and unanswered picks from earlier visits, oldest first.
function findReviewEntries(history, sessionIds = new Set()) {
  return history
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isAwaitingAnswer(entry) && !sessionIds.has(entry.id))
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
  return Boolean(loadTokens()?.access_token || loadManualList().trim());
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
    watch_links: meta.watch_links?.length ? meta.watch_links : pick.watch_links || []
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

  if (isMemoryExcludedTitle(recommendation.title, memory) || isMemoryExcludedTitle(recommendation.title_jp, memory)) {
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
    // Saved with the pick so later pools can exclude it by id, not just name.
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
