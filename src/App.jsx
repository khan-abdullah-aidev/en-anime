import { useEffect, useMemo, useRef, useState } from "react";
import { askEn, askEnVerdict } from "./openrouter.js";
import { beginMalOauth, finishMalOauth, refreshMalOauth } from "./oauth.js";
import { MalAuthError, fetchAnimeImage, fetchAnimeList, isMalAuthError } from "./mal.js";
import {
  appendHistory,
  clearRecommendationLog,
  clearTokens,
  deleteHistoryEntry,
  loadRecommendationMemoryCache,
  loadManualList,
  loadHistory,
  loadTasteProfileCache,
  loadTokens,
  recordRecommendedAnime,
  saveManualList,
  saveRecommendationMemoryCache,
  saveTasteProfileCache,
  updateHistoryEntry
} from "./storage.js";
import {
  buildCandidatePool,
  buildRecommendationMemory,
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
import { normalizeTitleForCompare } from "./titleUtils.js";

const VIEW = {
  LANDING: "landing",
  MANUAL: "manual",
  PENDING: "pending",
  MOOD: "mood",
  SHORTLIST: "shortlist",
  THINKING: "thinking",
  REVEAL: "reveal",
  FEEDBACK: "feedback",
  HISTORY: "history"
};

const MAX_RECOMMENDATION_ATTEMPTS = 3;

export default function App() {
  const [view, setView] = useState(VIEW.LANDING);
  const [tokens, setTokens] = useState(() => loadTokens());
  const [history, setHistory] = useState(() => loadHistory());
  const [mood, setMood] = useState("");
  const [shortlist, setShortlist] = useState("");
  const [manualList, setManualList] = useState(() => loadManualList());
  const [mode, setMode] = useState(() => (loadManualList() ? "manual" : "mal"));
  const [malList, setMalList] = useState([]);
  const [recommendation, setRecommendation] = useState(null);
  const [currentDraftEntry, setCurrentDraftEntry] = useState(null);
  const [pendingReviewIds, setPendingReviewIds] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const handledCallback = useRef(false);

  useEffect(() => {
    if (window.location.pathname !== "/callback" || handledCallback.current) return;

    handledCallback.current = true;
    setStatus("Receiving the thread from MyAnimeList");
    finishMalOauth(window.location.href)
      .then((nextTokens) => {
        setTokens(nextTokens);
        setMode("mal");
        goToMoodOrPending(loadHistory());
        setStatus("");
      })
      .catch((oauthError) => {
        setError(oauthError.message);
        setStatus("");
        setView(VIEW.LANDING);
      });
  }, []);

  useEffect(() => {
    if (tokens?.access_token && view === VIEW.LANDING) {
      setMode("mal");
      goToMoodOrPending(history);
    }
  }, [tokens, view]);

  async function handleConnect() {
    setError("");
    try {
      beginMalOauth();
    } catch (connectError) {
      setError(connectError.message);
    }
  }

  function handleManualStart() {
    setError("");
    setMode("manual");
    setView(VIEW.MANUAL);
  }

  function handleManualSubmit(value) {
    const nextValue = value.trim();
    setManualList(nextValue);
    saveManualList(nextValue);
    setMode("manual");
    goToMoodOrPending(history);
  }

  function goToMoodOrPending(nextHistory = history) {
    if (!hasRecommendationInput()) {
      setView(VIEW.LANDING);
      return;
    }

    const pendingIds = findPendingEntries(nextHistory).map((entry) => entry.id);
    setPendingReviewIds(pendingIds);
    setView(pendingIds.length ? VIEW.PENDING : VIEW.MOOD);
  }

  async function handleConsider(nextMood) {
    if (!hasRecommendationInput() || (mode !== "manual" && !tokens?.access_token)) {
      setView(VIEW.LANDING);
      return;
    }

    setError("");
    setRecommendation(null);
    setStatus(mode === "manual" ? "Reading what you told En" : "Reading your history");
    setView(VIEW.THINKING);

    try {
      const list =
        mode === "manual" ? manualList : await fetchAnimeListWithRefresh();
      setMalList(Array.isArray(list) ? list : []);
      setStatus("Listening to tonight");
      const previousTasteProfile = loadTasteProfileCache();
      const tasteProfile = buildTasteProfile({
        malList: list,
        feedbackHistory: history,
        previousProfile: previousTasteProfile
      });
      saveTasteProfileCache(tasteProfile);

      const recommendationMemory = buildRecommendationMemory({
        malList: list,
        history,
        existingMemory: loadRecommendationMemoryCache()
      });
      saveRecommendationMemoryCache(recommendationMemory);

      const recentPatterns = summarizeRecentPatterns(list, history);
      const feedbackSignals = compactFeedbackHistory(history);
      const candidateList = buildCandidatePool({
        mood: nextMood,
        tasteProfile,
        recentPatterns,
        memory: recommendationMemory
      });

      if (Array.isArray(list)) {
        console.log("[En debug] MAL list item count", list.length);
        console.log("[En debug] MAL status counts", countStatuses(list));
        console.log("[En debug] persistent memory counts", countMemory(recommendationMemory));
        console.log("[En debug] candidate count", candidateList.length);
      }

      const rec = await askForAllowedRecommendation({
        mood: nextMood,
        tasteProfile,
        recentPatterns,
        feedbackHistory: feedbackSignals,
        candidateList,
        memory: recommendationMemory
      });
      const imageUrl = await fetchAnimeImage(
        rec.title,
        mode === "manual" ? "" : tokens.access_token,
        [rec.title_jp, rec.title_en]
      );
      const recommendationWithImage = { ...rec, image_url: imageUrl || rec.image_url || "" };
      recordRecommendedAnime(recommendationWithImage, "recommended");

      const entry = {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        mood: nextMood || "Surprise me",
        recommendation: recommendationWithImage,
        note: "",
        feedback: "",
        state: "unrated"
      };

      setRecommendation(recommendationWithImage);
      setCurrentDraftEntry(entry);
      setStatus("");
      setView(VIEW.REVEAL);
    } catch (considerError) {
      if (isMalAuthError(considerError)) {
        clearExpiredMalSession();
        setError("Your MyAnimeList session expired. Please connect again.");
      } else {
        setError(considerError.message);
      }
      setStatus("");
      setView(isMalAuthError(considerError) ? VIEW.LANDING : VIEW.MOOD);
    }
  }

  function handleShortlistStart() {
    setError("");
    setView(VIEW.SHORTLIST);
  }

  async function handleVerdict(rawText) {
    const text = rawText.trim();
    if (!text || !hasRecommendationInput() || (mode !== "manual" && !tokens?.access_token)) {
      setView(VIEW.LANDING);
      return;
    }

    setError("");
    setRecommendation(null);
    setStatus(mode === "manual" ? "Reading what you told En" : "Reading your history");
    setView(VIEW.THINKING);

    try {
      const list =
        mode === "manual" ? manualList : await fetchAnimeListWithRefresh();
      setMalList(Array.isArray(list) ? list : []);
      setStatus("Weighing it against your history");
      const previousTasteProfile = loadTasteProfileCache();
      const tasteProfile = buildTasteProfile({
        malList: list,
        feedbackHistory: history,
        previousProfile: previousTasteProfile
      });
      saveTasteProfileCache(tasteProfile);

      const recommendationMemory = buildRecommendationMemory({
        malList: list,
        history,
        existingMemory: loadRecommendationMemoryCache()
      });
      saveRecommendationMemoryCache(recommendationMemory);

      const recentPatterns = summarizeRecentPatterns(list, history);
      const feedbackSignals = compactFeedbackHistory(history);
      const queriedTitles = splitShortlist(text);
      const candidateList = buildCandidatePool({
        mood: "",
        tasteProfile,
        recentPatterns,
        memory: recommendationMemory
      });

      const verdict = await askForAllowedVerdict({
        queriedTitles,
        tasteProfile,
        recentPatterns,
        feedbackHistory: feedbackSignals,
        candidateList,
        memory: recommendationMemory
      });
      const imageUrl = await fetchAnimeImage(
        verdict.title,
        mode === "manual" ? "" : tokens.access_token,
        [verdict.title_jp]
      );
      const recommendationWithImage = { ...verdict, image_url: imageUrl || verdict.image_url || "" };
      recordRecommendedAnime(recommendationWithImage, "recommended");

      const entry = {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        mood: `asked about ${verdict.queried_title}`,
        recommendation: recommendationWithImage,
        note: "",
        feedback: "",
        state: "unrated",
        mode: "verdict",
        queried_title: verdict.queried_title,
        verdict: verdict.verdict
      };

      setRecommendation(recommendationWithImage);
      setCurrentDraftEntry(entry);
      setStatus("");
      setView(VIEW.REVEAL);
    } catch (verdictError) {
      if (isMalAuthError(verdictError)) {
        clearExpiredMalSession();
        setError("Your MyAnimeList session expired. Please connect again.");
      } else {
        setError(verdictError.message);
      }
      setStatus("");
      setView(isMalAuthError(verdictError) ? VIEW.LANDING : VIEW.SHORTLIST);
    }
  }

  async function fetchAnimeListWithRefresh() {
    try {
      return await fetchAnimeList(tokens.access_token);
    } catch (listError) {
      if (!isMalAuthError(listError)) {
        throw listError;
      }

      try {
        setStatus("Refreshing MyAnimeList connection");
        const nextTokens = await refreshMalOauth(tokens);
        setTokens(nextTokens);
        return await fetchAnimeList(nextTokens.access_token);
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
    setRecommendation(null);
    setCurrentDraftEntry(null);
  }

  function handleFeedback(feedback, feedbackNote = "") {
    if (!currentDraftEntry) return;

    const patch =
      feedback === "pending"
        ? { feedback: "", feedback_note: "", state: "pending", note: "waiting in the watchlist" }
        : {
            feedback,
            state: "rated",
            feedback_note: feedbackNote.trim(),
            note: makeUserReflection(feedback, feedbackNote)
          };
    const nextHistory = appendHistory({ ...currentDraftEntry, ...patch });
    if (feedback === "pending") {
      recordRecommendedAnime(currentDraftEntry.recommendation, "pending");
      recordRecommendedAnime(currentDraftEntry.recommendation, "watchlisted");
    } else if (feedback === "good") {
      recordRecommendedAnime(currentDraftEntry.recommendation, "completed");
    } else if (feedback === "meh") {
      recordRecommendedAnime(currentDraftEntry.recommendation, "rejected");
    }
    setHistory(nextHistory);
    setCurrentDraftEntry(null);
    setView(VIEW.HISTORY);
  }

  function handlePendingAnswer(answer) {
    const reviewIds = pendingReviewIds.length
      ? pendingReviewIds
      : findPendingEntries(history).map((entry) => entry.id);
    const pending = findCurrentPending(history, reviewIds);
    if (!pending) {
      setPendingReviewIds([]);
      setView(VIEW.MOOD);
      return;
    }

    const remainingPendingIds = reviewIds.filter((id) => id !== pending.id);

    if (answer === "not-yet") {
      setPendingReviewIds(remainingPendingIds);
      setView(remainingPendingIds.length ? VIEW.PENDING : VIEW.MOOD);
      return;
    }

    const patch = {
      feedback: answer,
      state: "rated",
      feedback_note: "",
      note: makeUserReflection(answer, "")
    };
    const nextHistory = updateHistoryEntry(pending.id, patch);
    if (answer === "good") {
      recordRecommendedAnime(pending.recommendation, "completed");
    } else if (answer === "meh") {
      recordRecommendedAnime(pending.recommendation, "rejected");
    }
    setHistory(nextHistory);
    const nextPendingIds = remainingPendingIds.filter((id) =>
      nextHistory.some((entry) => entry.id === id && entry.state === "pending")
    );
    setPendingReviewIds(nextPendingIds);
    setView(nextPendingIds.length ? VIEW.PENDING : VIEW.MOOD);
  }

  function handleDeleteHistoryEntry(id) {
    const nextHistory = deleteHistoryEntry(id);
    setHistory(nextHistory);
    setPendingReviewIds((ids) => ids.filter((pendingId) => pendingId !== id));
  }

  function handleClearHistory() {
    if (history.length && !window.confirm("Clear En's recommendation log and local recommendation memory?")) {
      return;
    }

    const nextHistory = clearRecommendationLog();
    setHistory(nextHistory);
    setPendingReviewIds([]);
    setRecommendation(null);
    setCurrentDraftEntry(null);
  }

  function handleDisconnect() {
    clearTokens();
    setTokens(null);
    setMalList([]);
    setRecommendation(null);
    setCurrentDraftEntry(null);
    setView(VIEW.LANDING);
  }

  const nav = {
    goto: setView,
    log: () => setView(VIEW.HISTORY),
    newRecommendation: () => goToMoodOrPending(history),
    connect: handleConnect,
    manualStart: handleManualStart,
    manualSubmit: handleManualSubmit,
    consider: handleConsider,
    shortlistStart: handleShortlistStart,
    verdict: handleVerdict,
    feedback: handleFeedback,
    pendingAnswer: handlePendingAnswer,
    deleteHistoryEntry: handleDeleteHistoryEntry,
    clearHistory: handleClearHistory,
    disconnect: handleDisconnect
  };

  return (
    <div style={{ minHeight: "100vh", position: "relative" }}>
      {error ? <ErrorRibbon message={error} /> : null}
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
        <ScreenPending nav={nav} pending={findCurrentPending(history, pendingReviewIds)} />
      )}
      {view === VIEW.MOOD && (
        <ScreenMood
          onLog={nav.log}
          onConsider={() => handleConsider(mood)}
          onSurprise={() => handleConsider("")}
          onShortlist={nav.shortlistStart}
          mood={mood}
          setMood={setMood}
        />
      )}
      {view === VIEW.SHORTLIST && (
        <ScreenShortlist
          onLog={nav.log}
          onSubmit={(value) => handleVerdict(value)}
          shortlist={shortlist}
          setShortlist={setShortlist}
        />
      )}
      {view === VIEW.THINKING && (
        <ScreenThinking
          onLog={nav.log}
          status={status}
          mood={mood || shortlist}
          watchedCount={mode === "manual" ? manualList : malList.length}
          mode={mode}
        />
      )}
      {view === VIEW.REVEAL && recommendation && (
        <ScreenReveal nav={nav} pick={recommendation} />
      )}
      {view === VIEW.FEEDBACK && recommendation && (
        <ScreenFeedback nav={nav} pick={recommendation} />
      )}
      {view === VIEW.HISTORY && <ScreenHistory nav={nav} history={history} />}
    </div>
  );
}

function ErrorRibbon({ message }) {
  return (
    <div
      className="meta"
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
    </div>
  );
}

function Wordmark({ subtle }) {
  return (
    <div className="wordmark" style={{ opacity: subtle ? 0.85 : 1 }}>
      <span className="kanji">縁</span>
      <span style={{ fontStyle: "italic", fontSize: 20, letterSpacing: "0.04em" }}>
        En
      </span>
    </div>
  );
}

function Chrome({ step, total, right, onLog }) {
  return (
    <div className="app-chrome">
      <Wordmark />
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        {step != null && (
          <span className="meta" style={{ letterSpacing: "0.18em" }}>
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

          <h1
            className="serif-display fade-up delay-1"
            style={{
              fontSize: 76,
              margin: "36px 0 28px",
              lineHeight: 1.02,
              fontWeight: 300
            }}
          >
            One anime.
            <br />
            <span style={{ fontStyle: "italic", color: "var(--bone-2)" }}>
              Chosen for tonight.
            </span>
          </h1>

          <p
            className="fade-up delay-2"
            style={{
              fontSize: 18,
              lineHeight: 1.6,
              color: "var(--bone-2)",
              maxWidth: 440,
              margin: "0 auto 64px",
              fontWeight: 300
            }}
          >
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

          <div className="fade-up delay-4" style={{ marginTop: 80 }}>
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
              style={{
                opacity: manualList.trim().length ? 1 : 0.4,
                pointerEvents: manualList.trim().length ? "auto" : "none",
                transition: "opacity 0.4s ease"
              }}
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
            Did you watch {pending.recommendation.title}?
          </h2>

          <div className="choice-links fade-up delay-2" style={{ marginTop: 76 }}>
            <button className="btn-link" onClick={() => nav.pendingAnswer("good")}>
              It was good
            </button>
            <button className="btn-link" onClick={() => nav.pendingAnswer("meh")}>
              Meh
            </button>
            <button className="btn-link" onClick={() => nav.pendingAnswer("not-yet")}>
              Not yet
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenMood({ onLog, onConsider, onSurprise, onShortlist, mood, setMood }) {
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
              style={{
                opacity: mood.length ? 1 : 0.4,
                pointerEvents: mood.length ? "auto" : "none",
                transition: "opacity 0.4s ease"
              }}
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
              style={{
                opacity: shortlist.trim().length ? 1 : 0.4,
                pointerEvents: shortlist.trim().length ? "auto" : "none",
                transition: "opacity 0.4s ease"
              }}
            >
              Ask En
            </button>
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

function ScreenReveal({ nav, pick }) {
  return (
    <div className="app-frame reveal-a-frame">
      <div className="reveal-a-top">
        <Wordmark />
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <span className="meta" style={{ letterSpacing: "0.2em" }}>03 / 03</span>
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
            {pick.title_jp} ・ {formatJapaneseDate(new Date())}
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
          </div>

          <div className="reveal-scroll__copy ink-bloom delay-3">
            <div className="eyebrow shu">
              {pick.verdict === "yes"
                ? `・ yes — ${pick.queried_title}`
                : pick.verdict === "no"
                  ? `・ not ${pick.queried_title} — this instead`
                  : "・ for you, tonight"}
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

            <div
              style={{ marginTop: 36 }}
            >
              <button className="btn-link" onClick={() => nav.goto(VIEW.FEEDBACK)}>
                Begin
              </button>
            </div>
          </div>
        </div>
        <div className="reveal-scroll__seal meta jp">縁</div>
      </div>
    </div>
  );
}

function ScreenFeedback({ nav, pick }) {
  const [chosen, setChosen] = useState(null);
  const [mehNote, setMehNote] = useState("");

  function choose(value) {
    setChosen(value);
    if (value !== "meh") {
      setTimeout(() => nav.feedback(value), 650);
    }
  }

  return (
    <div className="app-frame">
      <Chrome onLog={nav.log} />
      <div className="app-stage">
        <div className="column" style={{ textAlign: "center", maxWidth: 560 }}>
          <div className="eyebrow fade-up">After watching</div>

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
              { k: "meh", label: "Meh" },
              { k: "pending", label: "Add to watchlist" }
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
              {chosen === "pending"
                ? "Saved. En will ask later."
                : chosen === "good"
                  ? "Noted. En will remember."
                  : "Tell En what missed, or leave it blank."}
            </p>
          )}

          {chosen === "meh" && (
            <div className="fade-in" style={{ marginTop: 28 }}>
              <input
                value={mehNote}
                onChange={(event) => setMehNote(event.target.value)}
                placeholder="what didn't land?"
                className="meh-note-input"
              />
              <div className="choice-links" style={{ marginTop: 24, gap: 16 }}>
                <button className="btn-link" onClick={() => nav.feedback("meh", mehNote)}>
                  Save
                </button>
                <button className="btn-quiet" onClick={() => nav.feedback("meh", "")}>
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

function ScreenHistory({ nav, history }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="app-frame">
      <Chrome
        right={
          <button className="btn-quiet" onClick={nav.newRecommendation}>
            new recommendation →
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
              gap: 22,
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
              refresh log
            </button>
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
                </div>

                <div>
                  <div className="jp" style={{ fontSize: 14, color: "var(--bone-3)", marginBottom: 4 }}>
                    {entry.recommendation.title_jp}
                  </div>
                  <h3
                    className="serif-display"
                    style={{ fontSize: 28, margin: 0, fontWeight: 300, fontStyle: "italic" }}
                  >
                    {entry.recommendation.title}
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
                  {entry.state === "rated" && entry.note && (
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

function formatCount(count) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(count);
}

function findCurrentPending(history, pendingReviewIds) {
  const pendingById = new Map(
    history
      .filter((entry) => entry.state === "pending")
      .map((entry) => [entry.id, entry])
  );
  return pendingReviewIds.map((id) => pendingById.get(id)).find(Boolean) || findPendingEntries(history)[0];
}

function findPendingEntries(history) {
  return history
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.state === "pending")
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

async function askForAllowedRecommendation({
  mood,
  tasteProfile,
  recentPatterns,
  feedbackHistory,
  candidateList,
  memory
}) {
  let lastValidationError = "";

  for (let attempt = 1; attempt <= MAX_RECOMMENDATION_ATTEMPTS; attempt += 1) {
    try {
      const recommendation = await askEn({
        mood,
        tasteProfile,
        recentPatterns,
        feedbackHistory,
        candidateList
      });
      const validation = validateRecommendation(recommendation, candidateList, memory);
      console.log("[En debug] returned recommendation validation", {
        attempt,
        recommendation,
        validation
      });

      if (validation.ok) {
        return mergeCandidateMeta(recommendation, validation.candidate);
      }

      lastValidationError = validation.error;
    } catch (error) {
      lastValidationError = error.message;
      console.warn("[En debug] recommendation attempt failed", { attempt, error });
    }
  }

  console.warn("[En debug] falling back to deterministic ranking", lastValidationError);
  return deterministicRecommendation(candidateList);
}

async function askForAllowedVerdict({
  queriedTitles,
  tasteProfile,
  recentPatterns,
  feedbackHistory,
  candidateList,
  memory
}) {
  let lastValidationError = "";

  for (let attempt = 1; attempt <= MAX_RECOMMENDATION_ATTEMPTS; attempt += 1) {
    try {
      const verdict = await askEnVerdict({
        queriedTitles,
        tasteProfile,
        recentPatterns,
        feedbackHistory,
        candidateList
      });
      const validation = validateVerdict(verdict, queriedTitles, candidateList, memory);
      console.log("[En debug] returned verdict validation", { attempt, verdict, validation });

      if (validation.ok) {
        return validation.candidate ? mergeCandidateMeta(verdict, validation.candidate) : verdict;
      }

      lastValidationError = validation.error;
    } catch (error) {
      lastValidationError = error.message;
      console.warn("[En debug] verdict attempt failed", { attempt, error });
    }
  }

  console.warn("[En debug] falling back to deterministic veto", lastValidationError);
  const fallbackCandidate = candidateList[0];
  if (!fallbackCandidate) {
    throw new Error("No eligible anime remain after filtering.");
  }

  return {
    verdict: "no",
    queried_title: queriedTitles[0] || "that one",
    title: fallbackCandidate.title,
    title_jp: fallbackCandidate.title_jp || fallbackCandidate.title,
    year: fallbackCandidate.year,
    episodes: fallbackCandidate.episodes,
    genre: fallbackCandidate.genre,
    reason: "En couldn't confirm that pick against your history right now. This one is closest to what you've actually been drawn to.",
    log_line: "Signal's thin tonight. This one held up anyway."
  };
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

  if (verdict.verdict === "no") {
    if (isMemoryExcludedTitle(verdict.title, memory) || isMemoryExcludedTitle(verdict.title_jp, memory)) {
      return { ok: false, error: "alternative already exists in recommendation memory" };
    }

    if (titleMatchesAnyQueried(verdict.title, queriedTitles) || titleMatchesAnyQueried(verdict.title_jp, queriedTitles)) {
      return { ok: false, error: "alternative repeats the queried title" };
    }
  }

  const candidate = findCandidateByRecommendation(verdict, candidateList);
  return { ok: true, candidate };
}

function titleMatchesAnyQueried(title, queriedTitles) {
  const normalized = normalizeTitleForCompare(title);
  return Boolean(normalized) && queriedTitles.some((queried) => normalizeTitleForCompare(queried) === normalized);
}

function splitShortlist(text) {
  return text
    .split(/[\n,;]+|\bvs\.?\b|\bor\b/i)
    .map((title) => title.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function countStatuses(list) {
  return list.reduce((counts, anime) => {
    const status = anime.my_list_status?.status || "missing";
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function validateRecommendation(recommendation, candidateList, memory) {
  const required = ["title", "title_jp", "year", "episodes", "genre", "reason", "log_line"];
  const missing = required.find((key) => recommendation?.[key] === undefined || recommendation?.[key] === null || recommendation?.[key] === "");
  if (missing) {
    return { ok: false, error: `missing ${missing}` };
  }

  const candidate = findCandidateByRecommendation(recommendation, candidateList);
  if (!candidate) {
    return { ok: false, error: "title not in candidateList" };
  }

  if (isMemoryExcludedTitle(recommendation.title, memory) || isMemoryExcludedTitle(recommendation.title_jp, memory)) {
    return { ok: false, error: "title already exists in recommendation memory" };
  }

  const blockedEvidenceTitle = findBlockedEvidenceTitle(
    `${recommendation.reason} ${recommendation.log_line}`,
    memory
  );
  if (blockedEvidenceTitle) {
    return {
      ok: false,
      error: `reason referenced watchlisted or pending title: ${blockedEvidenceTitle}`
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
    image_url: candidate.image_url || recommendation.image_url || ""
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
