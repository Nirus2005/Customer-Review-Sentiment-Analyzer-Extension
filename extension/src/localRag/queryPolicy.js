import {
  ANSWER_STYLE_BY_INTENT,
  INTENT_LIMITS,
  RAG_LIMITS,
} from "../constants/ragConfig.js";
import {
  BALANCED_QUERY_PHRASES,
  DETAILED_QUERY_TERMS,
  NEGATIVE_QUERY_PHRASES,
  NEGATIVE_QUERY_TERMS,
  OVERALL_QUERY_PHRASES,
  OVERALL_QUERY_TERMS,
  POSITIVE_QUERY_PHRASES,
  POSITIVE_QUERY_TERMS,
  QUERY_TYPO_REPLACEMENTS,
  SOURCE_QUERY_PHRASES,
} from "../constants/queryLexicon.js";

export function analyzeQuery(question) {
  const normalizedQuestion = normalizeUserQuery(question);
  const querySentiment = detectQuerySentiment(normalizedQuestion);
  const queryIntent = detectQueryIntent(normalizedQuestion, querySentiment);

  return {
    normalizedQuestion,
    querySentiment,
    queryIntent,
    sentimentLabels: sentimentLabelsForQuery(querySentiment),
    limits: limitsForIntent(queryIntent),
    answerStyle: answerStyleForIntent(queryIntent),
  };
}

export function normalizeUserQuery(question) {
  let normalized = String(question || "").toLowerCase();

  QUERY_TYPO_REPLACEMENTS.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, replacement);
  });

  return normalized.replace(/\s+/g, " ").trim();
}

function detectQuerySentiment(question) {
  const normalized = normalizeUserQuery(question);

  if (BALANCED_QUERY_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return "balanced";
  }

  let negativeScore = NEGATIVE_QUERY_PHRASES.reduce(
    (score, phrase) => score + (normalized.includes(phrase) ? 2 : 0),
    0,
  );
  let positiveScore = POSITIVE_QUERY_PHRASES.reduce(
    (score, phrase) => score + (normalized.includes(phrase) ? 2 : 0),
    0,
  );

  const tokens = normalized.match(/[a-z][a-z-']*/g) || [];
  negativeScore += tokens.filter((token) => NEGATIVE_QUERY_TERMS.has(token)).length;
  positiveScore += tokens.filter((token) => POSITIVE_QUERY_TERMS.has(token)).length;

  if (negativeScore > positiveScore) {
    return "negative";
  }

  if (positiveScore > negativeScore) {
    return "positive";
  }

  return "neutral";
}

function detectQueryIntent(question, querySentiment = detectQuerySentiment(question)) {
  const normalized = normalizeUserQuery(question);
  const tokens = new Set(normalized.match(/[a-z][a-z-']*/g) || []);

  if (SOURCE_QUERY_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return "sources";
  }

  if (querySentiment === "balanced") {
    return "balanced";
  }

  if (querySentiment === "negative") {
    return "negative";
  }

  if (
    OVERALL_QUERY_PHRASES.some((phrase) => normalized.includes(phrase)) ||
    hasTokenOverlap(tokens, OVERALL_QUERY_TERMS)
  ) {
    return "overall";
  }

  if (querySentiment === "positive") {
    return "positive";
  }

  if (hasTokenOverlap(tokens, DETAILED_QUERY_TERMS)) {
    return "detailed";
  }

  return "neutral";
}

function sentimentLabelsForQuery(querySentiment) {
  if (querySentiment === "negative") {
    return ["negative", "mixed"];
  }

  if (querySentiment === "positive") {
    return ["positive", "mixed"];
  }

  return null;
}

export function fallbackAnswerForQuerySentiment(querySentiment) {
  if (querySentiment === "negative") {
    return "I could not find negative review evidence relevant to that in the analyzed reviews/comments.";
  }

  if (querySentiment === "positive") {
    return "I could not find positive review evidence relevant to that in the analyzed reviews/comments.";
  }

  return "I could not find anything relevant to that in the analyzed reviews/comments.";
}

function limitsForIntent(queryIntent) {
  const intentLimits = INTENT_LIMITS[queryIntent] || INTENT_LIMITS.neutral;
  const topK = Math.min(intentLimits.topK || RAG_LIMITS.topK, RAG_LIMITS.topK);
  const minSourceCount = Math.min(
    intentLimits.minSourceCount || RAG_LIMITS.minSourceCount,
    RAG_LIMITS.minSourceCount,
  );
  const maxSourceCount = clamp(
    intentLimits.maxSourceCount || RAG_LIMITS.maxSourceCount,
    minSourceCount,
    RAG_LIMITS.maxSourceCount,
  );

  return {
    topK,
    maxSourceCount,
    minSourceCount,
    fetchK: fetchKForIntent(topK, maxSourceCount),
    maxContextTokens: Math.min(
      intentLimits.maxContextTokens || RAG_LIMITS.maxContextTokens,
      RAG_LIMITS.maxContextTokens,
    ),
    maxNewTokens: Math.min(
      intentLimits.maxNewTokens || RAG_LIMITS.maxNewTokens,
      RAG_LIMITS.maxNewTokens,
    ),
    displaySourceCount: RAG_LIMITS.displaySourceCount,
  };
}

function answerStyleForIntent(queryIntent) {
  return ANSWER_STYLE_BY_INTENT[queryIntent] || ANSWER_STYLE_BY_INTENT.default;
}

function fetchKForIntent(topK, maxSourceCount) {
  const target = Math.max(topK * RAG_LIMITS.fetchMultiplier, maxSourceCount);
  return Math.max(topK, Math.min(RAG_LIMITS.maxSourceCount, target));
}

function hasTokenOverlap(tokens, targetTerms) {
  for (const token of tokens) {
    if (targetTerms.has(token)) {
      return true;
    }
  }

  return false;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
