import {
  MESSAGE_TYPES,
  MODEL_CONFIG,
  MODEL_ROLES,
  RAG_LIMITS,
} from "../constants/ragConfig.js";
import {
  answerContradictsEvidence,
  buildFallbackAnswer,
  buildAnalyticsText,
  formatContextForPrompt,
  formatRecentChat,
} from "../localRag/answerContext.js";
import {
  analyzeQuery,
  fallbackAnswerForQuerySentiment,
} from "../localRag/queryPolicy.js";
import {
  attachEmbeddingsToChunks,
  buildSessionMetrics,
  createReviewChunks,
  normalizeReviewSentiment,
} from "../localRag/reviewProcessing.js";
import {
  prepareReviewIndexPlan,
  selectBacklogReviewsForQuery,
} from "../localRag/progressiveIndex.js";
import { getEffectiveAiSettings } from "./aiSettingsStorage.js";
import {
  chunksToSources,
  retrieveRelevantChunks,
} from "../localRag/retrieval.js";
import {
  cleanAssistantAnswer,
  hasPromptEcho,
  isUnsafeGeneratedAnswer,
} from "../localRag/responseGuards.js";
import {
  appendLocalSessionChunks,
  getLocalSession,
  getLocalSessionChunks,
  saveLocalSession,
  updateLocalSession,
} from "../localRagStore.js";
import {
  classifyTextsLocally,
  embedTextsLocally,
  isAbortError,
  sendWorkerMessage,
  streamLocalGeneration,
  throwIfAborted,
} from "./modelClient.js";

export { makeMessageId } from "./modelClient.js";

export async function createLocalRagSession(tab, scrapedReviews, reportProgress = () => {}, options = {}) {
  const sessionId = makeLocalSessionId();
  const reviews = normalizeScrapedReviews(scrapedReviews);
  const indexPlan = prepareReviewIndexPlan(reviews, sessionId, {
    initialReviewLimit: options.initialReviewLimit,
  });
  const reviewsToIndex = indexPlan.initialReviews;

  reportProgress({
    stage: "preparing",
    message: "Preparing local AI models...",
  });
  const initResult = await sendWorkerMessage({
    type: MESSAGE_TYPES.INIT_MODELS,
    roles: [MODEL_ROLES.EMBEDDING, MODEL_ROLES.SENTIMENT],
  });
  const failedModel = Object.values(initResult.models || {}).find((model) => !model.ok);

  if (failedModel) {
    throw new Error(failedModel.error || "A local model failed to initialize.");
  }

  if (indexPlan.isProgressive) {
    reportProgress({
      stage: "preparing",
      message:
        `${reviewsToIndex.length} reviews will be ready first. ` +
        `${indexPlan.backlogReviews.length} more will be indexed as needed.`,
      current: reviewsToIndex.length,
      total: reviews.length,
    });
  }

  reportProgress({
    stage: "classifying",
    message: `Analyzing sentiment for ${reviewsToIndex.length} reviews...`,
    current: 0,
    total: reviewsToIndex.length,
  });
  const sentimentResults = await classifyTextsLocally(
    reviewsToIndex.map((review) => review.text),
    reportProgress,
    undefined,
    { stage: "classifying" },
  );
  const enrichedReviews = enrichReviewsWithSentiment(reviewsToIndex, sentimentResults);

  reportProgress({
    stage: "chunking",
    message: "Preparing review text for search...",
  });
  const chunks = createReviewChunks(enrichedReviews, sessionId);

  reportProgress({
    stage: "indexing",
    message: `Building searchable index for ${chunks.length} review chunks...`,
    current: 0,
    total: chunks.length,
  });
  const embeddings = await embedTextsLocally(
    chunks.map((chunk) => chunk.text),
    reportProgress,
    undefined,
    { stage: "indexing" },
  );
  const embeddedChunks = attachEmbeddingsToChunks(chunks, embeddings);
  const metrics = buildSessionMetrics(mergeMetricReviews(indexPlan.metricReviews, enrichedReviews));
  const session = {
    id: sessionId,
    tabId: tab.id ?? null,
    pageUrl: tab.url || null,
    pageTitle: tab.title || null,
    createdAt: new Date().toISOString(),
    reviewCount: reviews.length,
    indexedReviewCount: enrichedReviews.length,
    backlogReviewCount: indexPlan.backlogReviews.length,
    unqueuedReviewCount: indexPlan.unqueuedReviewCount,
    progressiveIndex: indexPlan.isProgressive,
    chunkCount: embeddedChunks.length,
    metrics,
    backlogReviews: indexPlan.backlogReviews,
    conversationSummary: "No earlier conversation summary.",
    models: {
      embedding: MODEL_CONFIG[MODEL_ROLES.EMBEDDING].model,
      sentiment: MODEL_CONFIG[MODEL_ROLES.SENTIMENT].model,
      generator: MODEL_CONFIG[MODEL_ROLES.GENERATOR].model,
    },
  };

  reportProgress({
    stage: "saving",
    message: "Saving review analysis...",
  });
  await saveLocalSession(session, embeddedChunks);

  reportProgress({
    stage: "ready",
    message: indexPlan.isProgressive
      ? `${session.indexedReviewCount} reviews ready. ${session.backlogReviewCount} more will be indexed as needed.`
      : `${session.indexedReviewCount} reviews ready.`,
    current: session.indexedReviewCount,
    total: session.reviewCount,
  });

  return sessionToClientSession(session);
}

export async function answerQuestionLocally({
  sessionId,
  question,
  expectedPageUrl,
  expectedTabId,
  recentMessages,
  signal,
  onToken,
  onIndexProgress,
}) {
  let [session, chunks] = await Promise.all([
    getLocalSession(sessionId),
    getLocalSessionChunks(sessionId),
  ]);

  if (!session || !chunks.length) {
    throw new Error("Local session not found. Refresh the review analysis and try again.");
  }

  if (!sessionMatchesExpectedPage(session, {
    expectedPageUrl,
    expectedTabId,
  })) {
    throw new Error("This chat belongs to another page. Analyze the current page to start fresh.");
  }

  const analysis = analyzeQuery(question);
  const retrievalQuestion = analysis.normalizedQuestion || question;
  ({ session, chunks } = await expandIndexForQuestion({
    session,
    chunks,
    question: retrievalQuestion,
    analysis,
    signal,
    reportProgress: onIndexProgress,
  }));
  throwIfAborted(signal);

  const [queryEmbedding] = await embedTextsLocally([retrievalQuestion], undefined, signal);
  const retrievedChunks = retrieveRelevantChunks({
    chunks,
    query: retrievalQuestion,
    queryEmbedding,
    analysis,
  });

  if (!retrievedChunks.length) {
    return {
      answer: fallbackAnswerForQuerySentiment(analysis.querySentiment),
      sources: [],
      session_meta: sessionToClientSession(session),
    };
  }

  const {
    context,
    contextChunks,
  } = formatContextForPrompt(
    retrievedChunks,
    analysis.limits.maxContextTokens,
  );
  const sources = chunksToSources(
    contextChunks.length ? contextChunks : retrievedChunks,
    analysis.limits.displaySourceCount,
  );
  const evidenceChunks = contextChunks.length ? contextChunks : retrievedChunks;
  const sessionAnalytics = buildAnalyticsText(session, analysis);
  const recentChat = formatRecentChat(recentMessages, RAG_LIMITS.maxRecentMessages);
  const conversationSummary = session.conversationSummary || "No earlier conversation summary.";
  const shouldStreamAnswer = await shouldStreamGeneratedAnswer();

  try {
    const generatedAnswer = await streamLocalGeneration({
      query: retrievalQuestion,
      context,
      recentChat,
      conversationSummary,
      sessionAnalytics,
      answerStyle: analysis.answerStyle,
      maxNewTokens: analysis.limits.maxNewTokens,
      signal,
      onToken: shouldStreamAnswer ? onToken : undefined,
    });
    const answer = cleanAssistantAnswer(generatedAnswer, question);
    const unsafe = (
      hasPromptEcho(generatedAnswer, question) ||
      isUnsafeGeneratedAnswer({
        rawAnswer: generatedAnswer,
        cleanedAnswer: answer,
        userQuestion: question,
      }) ||
      answerContradictsEvidence(answer, evidenceChunks, analysis)
    );

    if (answer && !unsafe) {
      return {
        answer,
        sources,
        session_meta: sessionToClientSession(session),
      };
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    console.warn("Local generator unavailable; using extractive fallback.", error);
  }

  return {
    answer: buildFallbackAnswer(retrievalQuestion, evidenceChunks, session),
    sources,
    session_meta: sessionToClientSession(session),
  };
}

async function shouldStreamGeneratedAnswer() {
  try {
    const settings = await getEffectiveAiSettings();
    return Boolean(settings.aiProvider && settings.aiProvider !== "local" && settings.aiApiKey);
  } catch {
    return false;
  }
}

async function expandIndexForQuestion({
  session,
  chunks,
  question,
  analysis,
  signal,
  reportProgress = () => {},
}) {
  const backlogReviews = Array.isArray(session.backlogReviews) ? session.backlogReviews : [];

  if (!backlogReviews.length) {
    return {
      session,
      chunks,
    };
  }

  reportProgress({
    stage: "lazy-selecting",
    message: `Checking ${backlogReviews.length} queued reviews for this question...`,
    indexedReviewCount: session.indexedReviewCount,
    backlogReviewCount: backlogReviews.length,
    reviewCount: session.reviewCount,
    chunkCount: chunks.length,
  });

  const {
    selectedReviews,
    remainingReviews,
  } = selectBacklogReviewsForQuery(backlogReviews, question, analysis);

  if (!selectedReviews.length) {
    return {
      session,
      chunks,
    };
  }

  throwIfAborted(signal);
  reportProgress({
    stage: "lazy-classifying",
    message: `Indexing ${selectedReviews.length} more queued reviews for this question...`,
    current: 0,
    total: selectedReviews.length,
    indexedReviewCount: session.indexedReviewCount,
    backlogReviewCount: backlogReviews.length,
    reviewCount: session.reviewCount,
    chunkCount: chunks.length,
  });
  const sentimentResults = await classifyTextsLocally(
    selectedReviews.map((review) => review.text),
    (progress) => reportProgress({
      ...progress,
      stage: "lazy-classifying",
      indexedReviewCount: session.indexedReviewCount,
      backlogReviewCount: backlogReviews.length,
      reviewCount: session.reviewCount,
      chunkCount: chunks.length,
    }),
    signal,
    { stage: "lazy-classifying" },
  );
  const enrichedReviews = enrichReviewsWithSentiment(selectedReviews, sentimentResults);
  const lazyChunks = createReviewChunks(enrichedReviews, session.id);

  reportProgress({
    stage: "lazy-indexing",
    message: `Building the searchable index for ${selectedReviews.length} more reviews...`,
    current: 0,
    total: lazyChunks.length,
    indexedReviewCount: session.indexedReviewCount,
    backlogReviewCount: backlogReviews.length,
    reviewCount: session.reviewCount,
    chunkCount: chunks.length,
  });
  const embeddings = await embedTextsLocally(
    lazyChunks.map((chunk) => chunk.text),
    (progress) => reportProgress({
      ...progress,
      stage: "lazy-indexing",
      indexedReviewCount: session.indexedReviewCount,
      backlogReviewCount: backlogReviews.length,
      reviewCount: session.reviewCount,
      chunkCount: chunks.length,
    }),
    signal,
    { stage: "lazy-indexing" },
  );
  const embeddedChunks = attachEmbeddingsToChunks(lazyChunks, embeddings);
  const nextSession = {
    ...session,
    updatedAt: new Date().toISOString(),
    backlogReviews: remainingReviews,
    backlogReviewCount: remainingReviews.length,
    indexedReviewCount: (Number(session.indexedReviewCount) || 0) + enrichedReviews.length,
    chunkCount: chunks.length + embeddedChunks.length,
  };

  reportProgress({
    stage: "lazy-saving",
    message: "Saving the updated review index...",
    current: selectedReviews.length,
    total: selectedReviews.length,
    indexedReviewCount: session.indexedReviewCount,
    backlogReviewCount: backlogReviews.length,
    reviewCount: session.reviewCount,
    chunkCount: chunks.length,
  });
  await Promise.all([
    appendLocalSessionChunks(embeddedChunks),
    updateLocalSession(nextSession),
  ]);

  reportProgress({
    stage: "lazy-ready",
    message: `${nextSession.indexedReviewCount} reviews ready. ${nextSession.backlogReviewCount} still queued.`,
    current: selectedReviews.length,
    total: selectedReviews.length,
    indexedReviewCount: nextSession.indexedReviewCount,
    backlogReviewCount: nextSession.backlogReviewCount,
    reviewCount: nextSession.reviewCount,
    chunkCount: nextSession.chunkCount,
  });

  return {
    session: nextSession,
    chunks: chunks.concat(embeddedChunks),
  };
}

function normalizeScrapedReviews(reviews) {
  return (Array.isArray(reviews) ? reviews : [])
    .map((review) => ({
      ...review,
      text: String(review?.text || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((review) => review.text);
}

function enrichReviewsWithSentiment(reviews, sentimentResults) {
  return reviews.map((review, index) => {
    const sentiment = normalizeReviewSentiment(sentimentResults[index], review.text);

    return {
      ...review,
      sentiment_label: sentiment.label,
      sentiment_score: sentiment.score,
    };
  });
}

function mergeMetricReviews(metricReviews, enrichedReviews) {
  const reviewsById = new Map(metricReviews.map((review) => [review.id, review]));

  enrichedReviews.forEach((review) => {
    reviewsById.set(review.id, review);
  });

  return Array.from(reviewsById.values())
    .sort((left, right) => (left.original_index || 0) - (right.original_index || 0));
}

function sessionToClientSession(session) {
  return {
    session_id: session.id,
    tab_id: session.tabId,
    page_url: session.pageUrl,
    page_title: session.pageTitle,
    review_count: session.reviewCount,
    indexed_review_count: session.indexedReviewCount,
    backlog_review_count: session.backlogReviewCount,
    progressive_index: session.progressiveIndex,
    unqueued_review_count: session.unqueuedReviewCount,
    chunk_count: session.chunkCount,
    metrics: session.metrics,
  };
}

function makeLocalSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return `local-${globalThis.crypto.randomUUID()}`;
  }

  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sessionMatchesExpectedPage(session, {
  expectedPageUrl,
  expectedTabId,
}) {
  const sessionUrl = normalizePageUrl(session?.pageUrl);
  const activeUrl = normalizePageUrl(expectedPageUrl);

  if (sessionUrl && activeUrl) {
    return sessionUrl === activeUrl;
  }

  const sessionTabId = session?.tabId ?? null;
  const activeTabId = expectedTabId ?? null;

  return sessionTabId !== null && activeTabId !== null && sessionTabId === activeTabId;
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
