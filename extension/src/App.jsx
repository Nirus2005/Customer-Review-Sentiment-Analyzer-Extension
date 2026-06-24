import React from "react";
import {
  AlertCircle,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  Settings,
  X,
} from "lucide-react";
import {
  AiDisclaimer,
  ChatPanel,
  LoadingProgressPanel,
  Metrics,
  RemainingReviewsProgressPanel,
  SessionSummary,
  StatusPanel,
  Suggestions,
} from "./components/PopupUI.jsx";
import { SettingsPanel } from "./options.jsx";
import {
  RAG_LIMITS,
  SELECTION_LAUNCH_STORAGE_KEY,
} from "./constants/ragConfig.js";
import {
  answerQuestionLocally,
  createLocalRagSession,
  makeMessageId,
} from "./services/localSessionService.js";
import {
  scrapeReviewsInTab,
  scrapeSelectionInTab,
} from "./services/scraperInjection.js";
import { getEffectiveAiSettings } from "./services/aiSettingsStorage.js";
import { deleteLocalSession } from "./localRagStore.js";

function getActivePageSelectionInfo() {
  const selection = typeof window !== "undefined" && typeof window.getSelection === "function"
    ? window.getSelection()
    : null;
  const selectedText = String(selection?.toString() || "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    hasSelection: selectedText.length > 0,
    rangeCount: selection?.rangeCount || 0,
    selectedTextLength: selectedText.length,
  };
}

function normalizeIndexingProgress(progress) {
  if (typeof progress === "string") {
    return {
      stage: "preparing",
      message: progress,
    };
  }

  if (progress && typeof progress === "object") {
    return {
      stage: progress.stage || "preparing",
      message: String(progress.message || "Analyzing reviews..."),
      current: finiteNumberOrUndefined(progress.current),
      total: finiteNumberOrUndefined(progress.total),
      indexedReviewCount: finiteNumberOrUndefined(progress.indexedReviewCount),
      backlogReviewCount: finiteNumberOrUndefined(progress.backlogReviewCount),
      reviewCount: finiteNumberOrUndefined(progress.reviewCount),
      chunkCount: finiteNumberOrUndefined(progress.chunkCount),
    };
  }

  return {
    stage: "preparing",
    message: "Analyzing reviews...",
  };
}

export default function App() {
  const [sessionId, setSessionId] = React.useState(null);
  const [sessionMeta, setSessionMeta] = React.useState(null);
  const [dashboard, setDashboard] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [question, setQuestion] = React.useState("");
  const [error, setError] = React.useState("");
  const [emptyState, setEmptyState] = React.useState(false);
  const [emptyStateSource, setEmptyStateSource] = React.useState(null);
  const [isIndexing, setIsIndexing] = React.useState(false);
  const [remainingReviewProgress, setRemainingReviewProgress] = React.useState(null);
  const [isChatBusy, setIsChatBusy] = React.useState(false);
  const chatMessagesRef = React.useRef(null);
  const activeGenerationRef = React.useRef(null);
  const [pendingReviews, setPendingReviews] = React.useState(null);
  const [selectedReviewCount, setSelectedReviewCount] = React.useState(0);
  const [activeTab, setActiveTab] = React.useState(null);
  const [activePopupTab, setActivePopupTab] = React.useState("assistant");
  const [showSetupModal, setShowSetupModal] = React.useState(false);
  const [hasPageSelection, setHasPageSelection] = React.useState(false);
  const [autoStartAfterSetup, setAutoStartAfterSetup] = React.useState(false);
  const [showSessionSummary, setShowSessionSummary] = React.useState(true);

  React.useEffect(() => {
    const chatMessages = chatMessagesRef.current;

    if (!chatMessages) {
      return;
    }

    window.requestAnimationFrame(() => {
      chatMessages.scrollTo({
        top: chatMessages.scrollHeight,
        behavior: "smooth",
      });
    });
  }, [messages, isChatBusy]);

  React.useEffect(() => {
    let cancelled = false;

    async function showSetupWhenCloudKeyIsMissing() {
      try {
        const hasCloudKey = await hasConfiguredCloudProvider();

        if (!cancelled && !hasCloudKey) {
          setShowSetupModal(true);
        }
      } catch {
        if (!cancelled) {
          setShowSetupModal(true);
        }
      }
    }

    showSetupWhenCloudKeyIsMissing();

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    async function startFromSelectionButton() {
      try {
        const launch = await consumeSelectionLaunchRequest();

        if (cancelled || !isFreshSelectionLaunch(launch)) {
          return;
        }

        const currentTab = await getCurrentActiveTab();

        if (cancelled || !currentTab?.id || !launchMatchesCurrentTab(launch, currentTab)) {
          return;
        }

        if (launch.selectionScrapeResult) {
          await startFromCapturedSelection(launch.selectionScrapeResult, currentTab);
          return;
        }

        createOrRefreshSession(false, {
          autoStartSelection: true,
          selectionRequired: true,
        });
      } catch {
        // Ignore launch handoff failures; the normal toolbar flow still works.
      }
    }

    startFromSelectionButton();

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (activePopupTab !== "assistant") {
      return undefined;
    }

    let cancelled = false;

    async function refreshPageSelectionState() {
      try {
        const tab = await getCurrentActiveTab();

        if (!tab?.id) {
          return;
        }

        const selectionInfo = await getPageSelectionInfo(tab.id);

        if (!cancelled) {
          setHasPageSelection(selectionInfo.hasSelection);
        }
      } catch {
        if (!cancelled) {
          setHasPageSelection(false);
        }
      }
    }

    refreshPageSelectionState();

    return () => {
      cancelled = true;
    };
  }, [activePopupTab]);

  React.useEffect(() => {
    if (!sessionMeta && !pendingReviews) {
      return undefined;
    }

    let cancelled = false;

    async function clearStateWhenPageChanges() {
      const currentTab = await getCurrentActiveTab();

      if (cancelled || !currentTab?.id) {
        return;
      }

      setActiveTab(currentTab);

      if (sessionMeta && !isSamePage(currentTab, sessionMeta)) {
        const staleSessionId = sessionId;

        resetSessionState();
        if (staleSessionId) {
          deleteSessionQuietly(staleSessionId);
        }
        setError("Page changed. Analyze the current page before chatting.");
        return;
      }

      if (pendingReviews && !isSamePage(currentTab, pendingReviews)) {
        setPendingReviews(null);
        setError("Page changed. Analyze the current page again.");
      }
    }

    clearStateWhenPageChanges();
    const intervalId = window.setInterval(clearStateWhenPageChanges, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pendingReviews, sessionId, sessionMeta]);

  async function createOrRefreshSession(shouldRefresh = false, options = {}) {
    setIsIndexing(true);
    setError("");
    setEmptyState(false);
    setEmptyStateSource(null);
    setPendingReviews(null);

    try {
      if (shouldRefresh && sessionId) {
        await deleteSessionQuietly(sessionId);
      }

      resetSessionState();
      reportIndexingProgress({
        stage: "reading",
        message: "Checking the current page for a review selection...",
      });

      const tab = await getCurrentActiveTab();

      if (!tab?.id) {
        throw new Error("No active browser tab found.");
      }

      setActiveTab(tab);

      const selectionInfo = await getPageSelectionInfo(tab.id);
      setHasPageSelection(selectionInfo.hasSelection);
      reportIndexingProgress({
        stage: "reading",
        message: selectionInfo.hasSelection
          ? "Reading reviews from your selection..."
          : "Reading visible reviews from the current page...",
      });
      const selectionScrapeResult = await scrapeSelectionInTab({
        tabId: tab.id,
        frameId: selectionInfo.hasSelection ? selectionInfo.frameId : undefined,
      });
      let scrapeResult = selectionScrapeResult;
      const usedSelection = Boolean(selectionScrapeResult.selectionFound || selectionScrapeResult.usedSelection);

      if (usedSelection) {
        setHasPageSelection(true);
      } else if (options.selectionRequired) {
        scrapeResult = {
          reviews: [],
          hitLimit: false,
          usedSelection: false,
        };
      } else {
        scrapeResult = await scrapeReviewsInTab({
          tabId: tab.id,
        });
      }

      const reviews = scrapeResult.reviews || [];

      if (!reviews.length) {
        setEmptyState(true);
        setEmptyStateSource(options.selectionRequired || selectionInfo.hasSelection || scrapeResult.usedSelection ? "selection" : "page");
        setIsIndexing(false);
        clearIndexingProgress();
        return;
      }

      const nextPendingReviews = {
        reviews,
        hitLimit: Boolean(scrapeResult.hitLimit),
        usedSelection,
        tabId: tab.id,
        pageUrl: normalizePageUrl(tab.url),
        pageTitle: tab.title || "",
      };
      const initialReviewProfile = await getInitialReviewProfile();
      const nextPendingReviewsWithProfile = {
        ...nextPendingReviews,
        initialReviewLimit: initialReviewProfile.limit,
        processingMode: initialReviewProfile.mode,
      };
      const nextSelectedReviewCount = initialReviewCountFor(reviews, initialReviewProfile);

      setPendingReviews(nextPendingReviewsWithProfile);
      setSelectedReviewCount(nextSelectedReviewCount);

      if (options.autoStartSelection && nextPendingReviewsWithProfile.usedSelection) {
        await processPendingReviews(nextPendingReviewsWithProfile, nextSelectedReviewCount);
      }
    } catch (caughtError) {
      setError(caughtError.message || "Failed to read reviews.");
    } finally {
      setIsIndexing(false);
      clearIndexingProgress();
    }
  }

  async function startFromCapturedSelection(scrapeResult, tab) {
    setIsIndexing(false);
    setError("");
    setEmptyState(false);
    setEmptyStateSource(null);
    setPendingReviews(null);
    resetSessionState();
    setActiveTab(tab);
    setHasPageSelection(true);

    const reviews = Array.isArray(scrapeResult?.reviews) ? scrapeResult.reviews : [];

    if (!reviews.length) {
      setEmptyState(true);
      setEmptyStateSource("selection");
      return;
    }

    const nextPendingReviews = buildPendingReviews({
      scrapeResult,
      tab,
      usedSelection: true,
    });
    const initialReviewProfile = await getInitialReviewProfile();
    const nextPendingReviewsWithProfile = {
      ...nextPendingReviews,
      initialReviewLimit: initialReviewProfile.limit,
      processingMode: initialReviewProfile.mode,
    };
    const nextSelectedReviewCount = initialReviewCountFor(reviews, initialReviewProfile);

    setPendingReviews(nextPendingReviewsWithProfile);
    setSelectedReviewCount(nextSelectedReviewCount);

    if (initialReviewProfile.mode === "cloud") {
      setAutoStartAfterSetup(false);
      await processPendingReviews(nextPendingReviewsWithProfile, nextSelectedReviewCount);
      return;
    }

    setAutoStartAfterSetup(true);
    setShowSetupModal(true);
  }

  async function handleProcessReviews() {
    if (!pendingReviews || !activeTab) return;

    await processPendingReviews(pendingReviews, selectedReviewCount);
  }

  async function processPendingReviews(reviewsToProcess, initialReviewCount) {
    const remainingReviewCount = Math.max(0, reviewsToProcess.reviews.length - initialReviewCount);
    setAutoStartAfterSetup(false);
    setIsIndexing(true);
    reportIndexingProgress({
      stage: "preparing",
      message: reviewsToProcess.usedSelection
        ? remainingReviewCount > 0
          ? `Preparing the first ${initialReviewCount} selected reviews for chat. ${remainingReviewCount} selected reviews will stay queued.`
          : `Preparing all ${initialReviewCount} selected reviews for chat...`
        : `Preparing the first ${initialReviewCount} page reviews for chat. The rest will stay queued.`,
      current: 0,
      total: initialReviewCount,
    });
    setError("");

    try {
      const currentTab = await getCurrentActiveTab();

      if (!currentTab?.id) {
        throw new Error("No active browser tab found.");
      }

      if (!isSamePage(currentTab, reviewsToProcess)) {
        setPendingReviews(null);
        setActiveTab(currentTab);
        throw new Error("The page changed after reviews were found. Analyze the current page again.");
      }

      const sessionData = await createLocalRagSession(
        currentTab,
        reviewsToProcess.reviews,
        reportIndexingProgress,
        { initialReviewLimit: initialReviewCount },
      );
      applySessionData(sessionData, reviewsToProcess.hitLimit);
      setPendingReviews(null);
    } catch (caughtError) {
      setError(caughtError.message || "Failed to analyze reviews.");
    } finally {
      setIsIndexing(false);
      clearIndexingProgress();
    }
  }

  function buildPendingReviews({
    scrapeResult,
    tab,
    usedSelection,
  }) {
    return {
      reviews: Array.isArray(scrapeResult?.reviews) ? scrapeResult.reviews : [],
      hitLimit: Boolean(scrapeResult?.hitLimit),
      usedSelection: Boolean(usedSelection || scrapeResult?.usedSelection || scrapeResult?.selectionFound),
      tabId: tab.id,
      pageUrl: normalizePageUrl(tab.url),
      pageTitle: tab.title || "",
    };
  }

  function applySessionData(sessionData, hitLimit) {
    const indexedReviewCount = sessionData.indexed_review_count ?? sessionData.review_count;
    const backlogReviewCount = sessionData.backlog_review_count ?? 0;

    setSessionId(sessionData.session_id);
    setSessionMeta({
      tabId: sessionData.tab_id ?? null,
      pageUrl: normalizePageUrl(sessionData.page_url),
      pageTitle: sessionData.page_title || "",
      reviewCount: sessionData.review_count,
      indexedReviewCount,
      backlogReviewCount,
      unqueuedReviewCount: sessionData.unqueued_review_count ?? 0,
      progressiveIndex: Boolean(sessionData.progressive_index),
      chunkCount: sessionData.chunk_count,
      hitLimit,
    });
    setShowSessionSummary(true);
    clearRemainingReviewProgress();
    setDashboard(buildDashboardFromSession(sessionData));
    setMessages([
      {
        id: makeMessageId(),
        role: "assistant",
        content: backlogReviewCount > 0
          ? `${indexedReviewCount} reviews are ready. ${backlogReviewCount} more will be indexed as needed. Ask about complaints, positive feedback, risks, delivery, quality, or any pattern in the reviews/comments.`
          : "Reviews analyzed. Ask about complaints, positive feedback, risks, delivery, quality, or any pattern in the reviews/comments.",
        sources: [],
      },
    ]);
  }

  function buildDashboardFromSession(sessionData) {
    const metrics = sessionData.metrics || {};

    return {
      totalReviews: metrics.total_reviews ?? sessionData.review_count ?? 0,
      positiveCount: metrics.positive ?? 0,
      negativeCount: metrics.negative ?? 0,
      mixedCount: metrics.mixed ?? 0,
      positivePct: metrics.positive_pct ?? 0,
      negativePct: metrics.negative_pct ?? 0,
      mixedPct: metrics.mixed_pct ?? 0,
    };
  }

  async function sendQuestion(nextQuestion) {
    const cleanQuestion = nextQuestion.trim();

    if (!sessionId) {
      setError("Analyze reviews first.");
      return;
    }

    if (!cleanQuestion || isChatBusy) {
      return;
    }

    const currentTab = await getCurrentActiveTab();

    if (!currentTab?.id) {
      setError("No active browser tab found.");
      return;
    }

    if (!isSamePage(currentTab, sessionMeta)) {
      const staleSessionId = sessionId;

      await deleteSessionQuietly(staleSessionId);
      resetSessionState();
      setActiveTab(currentTab);
      setError("This chat belongs to another page. Analyze the current page to start fresh.");
      return;
    }

    setError("");
    setQuestion("");
    const assistantMessageId = makeMessageId();
    const priorMessages = messages;
    const generationController = new AbortController();
    activeGenerationRef.current = {
      assistantMessageId,
      controller: generationController,
    };

    setMessages((currentMessages) => [
      ...currentMessages,
      {
        id: makeMessageId(),
        role: "user",
        content: cleanQuestion,
      },
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        sources: [],
        streaming: true,
      },
    ]);
    setIsChatBusy(true);

    try {
      const result = await answerQuestionLocally({
        sessionId,
        question: cleanQuestion,
        expectedPageUrl: currentTab.url,
        expectedTabId: currentTab.id,
        recentMessages: priorMessages,
        signal: generationController.signal,
        onIndexProgress: reportRemainingReviewProgress,
        onToken: (partialAnswer) => {
          if (generationController.signal.aborted) {
            return;
          }

          updateAssistantMessage(assistantMessageId, {
            content: partialAnswer,
            streaming: true,
          });
        },
      });

      if (generationController.signal.aborted) {
        return;
      }

      updateSessionMetaFromResult(result.session_meta);
      updateAssistantMessage(assistantMessageId, {
        content: result.answer,
        sources: result.sources,
        streaming: false,
      });
    } catch (caughtError) {
      if (caughtError?.name === "AbortError") {
        updateAssistantMessage(assistantMessageId, {
          content: "Generation stopped.",
          sources: [],
          streaming: false,
        });
        return;
      }

      setMessages((currentMessages) => currentMessages.filter(
        (message) => message.id !== assistantMessageId,
      ));
      setError(caughtError.message || "Chat request failed.");
    } finally {
      if (activeGenerationRef.current?.controller === generationController) {
        activeGenerationRef.current = null;
      }

      setIsChatBusy(false);
      clearRemainingReviewProgress();
    }
  }

  function stopGeneration() {
    const activeGeneration = activeGenerationRef.current;

    if (!activeGeneration) {
      return;
    }

    activeGeneration.controller.abort();
    updateAssistantMessage(activeGeneration.assistantMessageId, {
      content: "Generation stopped.",
      sources: [],
      streaming: false,
    });
  }

  function updateAssistantMessage(messageId, patch) {
    setMessages((currentMessages) => currentMessages.map((message) => (
      message.id === messageId
        ? {
          ...message,
          ...patch,
        }
        : message
    )));
  }

  const hasSession = Boolean(sessionId);
  const isFindingReviews = isIndexing && !pendingReviews;
  const pendingInitialReviewLimit = pendingReviews?.initialReviewLimit || RAG_LIMITS.maxInitialIndexedReviews;
  const pendingProcessingModeLabel = pendingReviews?.processingMode === "local"
    ? "local mode"
    : "cloud/API mode";

  function resetSessionState() {
    setSessionId(null);
    setSessionMeta(null);
    setDashboard(null);
    setMessages([]);
    setQuestion("");
    setShowSessionSummary(true);
    setAutoStartAfterSetup(false);
    clearIndexingProgress();
    clearRemainingReviewProgress();
    setIsChatBusy(false);
    activeGenerationRef.current?.controller.abort();
    activeGenerationRef.current = null;
  }

  function reportIndexingProgress() {
    // Detailed setup stages are intentionally not shown in the popup.
  }

  function clearIndexingProgress() {
    // The setup loader is intentionally generic; detailed stages stay internal.
  }

  function reportRemainingReviewProgress(nextProgress) {
    const progress = normalizeIndexingProgress(nextProgress);

    setRemainingReviewProgress(progress);

    if (
      progress.indexedReviewCount !== undefined ||
      progress.backlogReviewCount !== undefined ||
      progress.reviewCount !== undefined ||
      progress.chunkCount !== undefined
    ) {
      updateSessionMetaFromProgress(progress);
    }
  }

  function clearRemainingReviewProgress() {
    setRemainingReviewProgress(null);
  }

  function updateSessionMetaFromProgress(progress) {
    setSessionMeta((currentMeta) => {
      if (!currentMeta) {
        return currentMeta;
      }

      return {
        ...currentMeta,
        reviewCount: progress.reviewCount ?? currentMeta.reviewCount,
        indexedReviewCount: progress.indexedReviewCount ?? currentMeta.indexedReviewCount,
        backlogReviewCount: progress.backlogReviewCount ?? currentMeta.backlogReviewCount,
        chunkCount: progress.chunkCount ?? currentMeta.chunkCount,
      };
    });
  }

  function updateSessionMetaFromResult(sessionData) {
    if (!sessionData) {
      return;
    }

    setSessionMeta((currentMeta) => {
      if (!currentMeta) {
        return currentMeta;
      }

      return {
        ...currentMeta,
        tabId: sessionData.tab_id ?? currentMeta.tabId,
        pageUrl: normalizePageUrl(sessionData.page_url) || currentMeta.pageUrl,
        pageTitle: sessionData.page_title || currentMeta.pageTitle,
        reviewCount: sessionData.review_count ?? currentMeta.reviewCount,
        indexedReviewCount: sessionData.indexed_review_count ?? currentMeta.indexedReviewCount,
        backlogReviewCount: sessionData.backlog_review_count ?? currentMeta.backlogReviewCount,
        unqueuedReviewCount: sessionData.unqueued_review_count ?? currentMeta.unqueuedReviewCount,
        progressiveIndex: sessionData.progressive_index ?? currentMeta.progressiveIndex,
        chunkCount: sessionData.chunk_count ?? currentMeta.chunkCount,
      };
    });
  }

  async function deleteSessionQuietly(targetSessionId) {
    try {
      await deleteLocalSession(targetSessionId);
    } catch {
      // Ignore cleanup errors in the popup.
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    sendQuestion(question);
  }

  async function handleSettingsSaved() {
    setShowSetupModal(false);
    setActivePopupTab("assistant");

    if (!autoStartAfterSetup || !pendingReviews) {
      return;
    }

    if (await hasConfiguredCloudProvider()) {
      const initialReviewProfile = await getInitialReviewProfile();
      const nextPendingReviews = {
        ...pendingReviews,
        initialReviewLimit: initialReviewProfile.limit,
        processingMode: initialReviewProfile.mode,
      };
      const nextSelectedReviewCount = initialReviewCountFor(pendingReviews.reviews, initialReviewProfile);

      setPendingReviews(nextPendingReviews);
      setSelectedReviewCount(nextSelectedReviewCount);
      await processPendingReviews(nextPendingReviews, nextSelectedReviewCount);
      return;
    }

    setAutoStartAfterSetup(false);
  }

  async function getCurrentActiveTab() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    return tab || null;
  }

  async function getPageSelectionInfo(tabId) {
    const selectionResults = await executeScriptAcrossFrames(tabId, getActivePageSelectionInfo);
    const selectedFrame = selectionResults.find((item) => item.result?.hasSelection);

    return {
      frameId: Number.isInteger(selectedFrame?.frameId) ? selectedFrame.frameId : 0,
      hasSelection: Boolean(selectedFrame),
      selectedTextLength: selectedFrame?.result?.selectedTextLength || 0,
    };
  }

  async function executeScriptAcrossFrames(tabId, func, args = []) {
    try {
      return await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func,
        args,
      });
    } catch {
      return chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
      });
    }
  }

  async function consumeSelectionLaunchRequest() {
    const storageArea = chrome.storage.session || chrome.storage.local;
    const launch = await waitForStorageItem(storageArea, SELECTION_LAUNCH_STORAGE_KEY);

    await storageRemove(storageArea, SELECTION_LAUNCH_STORAGE_KEY);
    return launch;
  }

  function isFreshSelectionLaunch(launch) {
    const createdAt = Number(launch?.createdAt);

    return (
      launch?.source === "selection-button" &&
      Number.isFinite(createdAt) &&
      Date.now() - createdAt < 15_000
    );
  }

  function launchMatchesCurrentTab(launch, currentTab) {
    if (launch?.tabId && currentTab?.id) {
      return launch.tabId === currentTab.id;
    }

    return normalizePageUrl(launch?.pageUrl) === normalizePageUrl(currentTab?.url);
  }

  function storageGet(storageArea, key) {
    return new Promise((resolve, reject) => {
      storageArea.get([key], (result) => {
        const runtimeError = chrome.runtime.lastError;

        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve(result?.[key] || null);
      });
    });
  }

  async function hasConfiguredCloudProvider() {
    const settings = await getEffectiveAiSettings();
    return Boolean(settings.aiProvider && settings.aiProvider !== "local" && settings.aiApiKey);
  }

  async function getInitialReviewProfile() {
    let usesCloudProvider = false;

    try {
      usesCloudProvider = await hasConfiguredCloudProvider();
    } catch {
      usesCloudProvider = false;
    }

    return {
      mode: usesCloudProvider ? "cloud" : "local",
      limit: usesCloudProvider
        ? RAG_LIMITS.maxInitialIndexedReviews
        : RAG_LIMITS.localInitialIndexedReviews,
    };
  }

  function initialReviewCountFor(reviews, profile) {
    const reviewCount = Array.isArray(reviews) ? reviews.length : 0;
    const limit = Number(profile?.limit) || RAG_LIMITS.localInitialIndexedReviews;

    return Math.min(reviewCount, limit);
  }

  async function waitForStorageItem(storageArea, key) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = await storageGet(storageArea, key);

      if (value) {
        return value;
      }

      await delay(50);
    }

    return null;
  }

  function storageRemove(storageArea, key) {
    return new Promise((resolve, reject) => {
      storageArea.remove(key, () => {
        const runtimeError = chrome.runtime.lastError;

        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve();
      });
    });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }

  function isSamePage(currentTab, analysisTarget) {
    const currentUrl = normalizePageUrl(currentTab?.url);
    const targetUrl = normalizePageUrl(analysisTarget?.pageUrl);

    if (currentUrl && targetUrl) {
      return currentUrl === targetUrl;
    }

    const currentTabId = currentTab?.id ?? null;
    const targetTabId = analysisTarget?.tabId ?? null;

    return currentTabId !== null && targetTabId !== null && currentTabId === targetTabId;
  }

  function normalizePageUrl(url) {
    const cleanUrl = String(url || "").trim();

    if (!cleanUrl) {
      return "";
    }

    try {
      const parsedUrl = new URL(cleanUrl);
      parsedUrl.hash = "";
      return parsedUrl.toString();
    } catch {
      return cleanUrl.replace(/#.*$/, "");
    }
  }

  return (
    <main className="max-h-[600px] w-[430px] overflow-y-auto bg-zinc-100 p-3 text-zinc-950">
      <header className="rounded-lg border border-zinc-200 bg-white px-3 py-3 text-zinc-950 shadow-sm">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 rounded-md border border-zinc-950 bg-zinc-950 p-2 text-white">
            <MessageSquareText size={18} strokeWidth={2.25} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold leading-tight tracking-normal">Verdict</h1>
            <p className="mt-1 text-[13px] leading-snug text-zinc-600">
              Ask questions about reviews, find the ones that matter to you, and see what people like,
              dislike, and mention most.
            </p>
          </div>
        </div>
      </header>

      <nav className="mt-3 grid grid-cols-2 gap-1 rounded-lg border border-zinc-200 bg-white p-1 shadow-sm" aria-label="Popup sections">
        <PopupTabButton
          active={activePopupTab === "assistant"}
          icon={<MessageSquareText size={15} />}
          label="Assistant"
          onClick={() => setActivePopupTab("assistant")}
        />
        <PopupTabButton
          active={activePopupTab === "settings"}
          icon={<Settings size={15} />}
          label="Settings"
          onClick={() => setActivePopupTab("settings")}
        />
      </nav>

      {showSetupModal && (
        <SetupPromptModal
          onClose={() => setShowSetupModal(false)}
          onOpenSettings={() => {
            setShowSetupModal(false);
            setActivePopupTab("settings");
          }}
        />
      )}

      {activePopupTab === "settings" ? (
        <section className="mt-3">
          <SettingsPanel
            embedded
            onSaved={handleSettingsSaved}
          />
        </section>
      ) : (
        <>
          <section className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <button
              type="button"
              onClick={() => createOrRefreshSession(false)}
              disabled={isIndexing || pendingReviews}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-zinc-950 px-3 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isFindingReviews ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
              {isFindingReviews ? "Finding Reviews" : hasPageSelection ? "Analyze Selection" : "Analyze Reviews"}
            </button>

            <button
              type="button"
              onClick={() => createOrRefreshSession(true)}
              disabled={isIndexing || !sessionId}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-[13px] font-semibold text-zinc-900 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="Refresh session"
            >
              <RefreshCw size={15} className={isFindingReviews ? "animate-spin" : ""} />
              Refresh
            </button>
          </section>

          {pendingReviews && !isIndexing && (
            <section className="mt-3 rounded-lg border border-zinc-200 bg-white p-3 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-zinc-950">
                Found {pendingReviews.reviews.length} reviews{pendingReviews.usedSelection ? " from your selection" : ""}
              </h2>
              {pendingReviews.usedSelection ? (
                <p className="mb-3 text-[13px] text-zinc-600">
                  {pendingReviews.reviews.length > selectedReviewCount
                    ? `Using ${pendingProcessingModeLabel}, Verdict will make the first ${selectedReviewCount} selected reviews ready before chat opens. The remaining ${pendingReviews.reviews.length - selectedReviewCount} selected reviews will be indexed as needed.`
                    : `Using ${pendingProcessingModeLabel}, Verdict will make all ${pendingReviews.reviews.length} selected reviews ready before chat opens.`}
                </p>
              ) : (
                <>
                  <p className="mb-3 text-[13px] text-zinc-600">
                    Verdict starts with a limited first batch so chat opens sooner. You are using {pendingProcessingModeLabel}, so the initial batch is capped at {pendingInitialReviewLimit} reviews. Choose how many page reviews should be ready immediately; the rest will be indexed as needed.
                  </p>

                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="1"
                      max={Math.min(pendingReviews.reviews.length, pendingInitialReviewLimit)}
                      value={selectedReviewCount}
                      onChange={(e) => setSelectedReviewCount(Number(e.target.value))}
                      className="flex-1 accent-zinc-950"
                    />
                    <span className="w-8 text-right text-sm font-semibold text-zinc-900">{selectedReviewCount}</span>
                  </div>
                </>
              )}

              <button
                type="button"
                onClick={handleProcessReviews}
                disabled={isIndexing}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md bg-zinc-950 py-2 text-[13px] font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pendingReviews.usedSelection
                  ? pendingReviews.reviews.length > selectedReviewCount
                    ? `Start Chat with First ${selectedReviewCount} Selected Reviews`
                    : "Start Chat with Selection"
                  : `Start Chat with First ${selectedReviewCount} Reviews`}
              </button>
            </section>
          )}

          {isIndexing && pendingReviews && (
            <LoadingProgressPanel
              icon={<Loader2 className="animate-spin" size={18} />}
            />
          )}

          {error && (
            <StatusPanel tone="error" icon={<AlertCircle size={18} />}>
              {error}
            </StatusPanel>
          )}

          {emptyState && (
            <StatusPanel tone="warning" title="No review text found" icon={<AlertCircle size={18} />}>
              {emptyStateSource === "selection"
                ? "Could not find reviews in your selection. Select a larger review area, including several review cards, then open Verdict and analyze again."
                : "Could not find review text on this page. Select the review content on the website first, then open Verdict and analyze again."}
            </StatusPanel>
          )}

          {sessionMeta && showSessionSummary && (
            <SessionSummary
              sessionMeta={sessionMeta}
              onDismiss={() => setShowSessionSummary(false)}
            />
          )}
          {sessionMeta && (
            <RemainingReviewsProgressPanel
              sessionMeta={sessionMeta}
              progress={remainingReviewProgress}
            />
          )}
          {dashboard && <Metrics dashboard={dashboard} />}

          {hasSession && (
            <Suggestions
              disabled={isChatBusy}
              onSelect={(suggestedQuestion) => sendQuestion(suggestedQuestion)}
            />
          )}

          {hasSession && <AiDisclaimer />}

          {hasSession && (
            <ChatPanel
              messages={messages}
              isChatBusy={isChatBusy}
              question={question}
              onQuestionChange={setQuestion}
              onSubmit={handleSubmit}
              onStopGeneration={stopGeneration}
              chatMessagesRef={chatMessagesRef}
            />
          )}
        </>
      )}
    </main>
  );
}

function finiteNumberOrUndefined(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function SetupPromptModal({ onClose, onOpenSettings }) {
  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center bg-black/20 px-3 pt-3" role="presentation">
      <section
        className="relative w-full max-w-[360px] rounded-lg border border-zinc-200 bg-white p-3.5 text-zinc-950 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-modal-title"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950"
          aria-label="Close setup prompt"
          title="Close"
        >
          <X size={15} />
        </button>

        <h2 id="setup-modal-title" className="pr-8 text-base font-semibold leading-tight">
          Set up Verdict before use
        </h2>
        <p className="mt-2 text-[13px] leading-snug text-zinc-600">
          Local models can work, but they are slower for preprocessing and chat. API providers are preferred because they usually analyze more reviews faster, produce stronger answers, and reduce browser load.
        </p>

        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex min-h-9 items-center justify-center rounded-md bg-zinc-950 px-3 py-2 text-[13px] font-semibold text-white transition hover:bg-black"
          >
            Open Settings
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-9 items-center justify-center rounded-md border border-zinc-200 bg-white px-3 py-2 text-[13px] font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
          >
            Later
          </button>
        </div>
      </section>
    </div>
  );
}

function PopupTabButton({ active, icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 py-2 text-[13px] font-semibold transition ${
        active
          ? "bg-zinc-950 text-white shadow-sm"
          : "bg-transparent text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
