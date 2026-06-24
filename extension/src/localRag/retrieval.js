import { RAG_LIMITS } from "../constants/ragConfig.js";
import { RETRIEVAL_STOP_WORDS } from "../constants/queryLexicon.js";
import { NEGATIVE_SIGNAL, POSITIVE_SIGNAL } from "./reviewProcessing.js";

const QUERY_INTENT_ONLY_TERMS = new Set([
  "bad",
  "complaint",
  "complaints",
  "concern",
  "concerns",
  "con",
  "cons",
  "dislike",
  "drawback",
  "drawbacks",
  "good",
  "great",
  "issue",
  "issues",
  "like",
  "liked",
  "likes",
  "love",
  "loved",
  "negative",
  "positive",
  "problem",
  "problems",
  "pro",
  "pros",
  "risk",
  "risks",
]);

const QUERY_TERM_ALIASES = {
  delivered: ["deliver", "delivered", "delivery"],
  delivery: ["deliver", "delivered", "delivery"],
  durability: ["durability", "durable"],
  package: ["package", "packaged", "packaging"],
  packaging: ["package", "packaged", "packaging"],
  ship: ["ship", "shipped", "shipping"],
  shipped: ["ship", "shipped", "shipping"],
  shipping: ["ship", "shipped", "shipping"],
};

export function retrieveRelevantChunks({
  chunks,
  query,
  queryEmbedding,
  analysis,
}) {
  const limits = analysis?.limits || {};
  const filter = buildQueryFilter(analysis, query);
  const queryTerms = meaningfulTerms(query);
  const subjectTerms = subjectTermsForQuery(queryTerms);
  const hasStrictSentimentFilter = Boolean(filter.sentimentLabels);
  let candidates = applyQueryFilter(chunks, filter);
  candidates = focusCandidatesBySubjectTerms(candidates, subjectTerms, hasStrictSentimentFilter);

  if (
    candidates.length < (limits.minSourceCount || RAG_LIMITS.minSourceCount) &&
    !hasStrictSentimentFilter
  ) {
    candidates = chunks;
  }

  const scoredChunks = candidates
    .map((chunk) => {
      const cosine = cosineSimilarity(queryEmbedding, chunk.embedding || []);
      const vectorScore = (cosine + 1) / 2;
      const lexicalScore = lexicalOverlapScore(queryTerms, chunk.text);
      const metadataScore = metadataRelevanceScore(filter, chunk);
      const score = clamp01((vectorScore * 0.72) + (lexicalScore * 0.12) + (metadataScore * 0.16));

      return {
        ...chunk,
        score,
      };
    })
    .sort((left, right) => right.score - left.score);
  const fetchLimit = limits.fetchK || Math.max(
    RAG_LIMITS.topK,
    RAG_LIMITS.topK * RAG_LIMITS.fetchMultiplier,
  );

  return selectRelevantChunks(scoredChunks.slice(0, fetchLimit), limits);
}

export function chunksToSources(chunks, limit = RAG_LIMITS.displaySourceCount) {
  return chunks.slice(0, limit).map((chunk) => ({
    chunk_id: chunk.id,
    review_id: chunk.reviewId,
    text: chunk.text,
    score: chunk.score,
    metadata: chunk.metadata || {},
  }));
}

function selectRelevantChunks(scoredChunks, limits) {
  if (!scoredChunks.length) {
    return [];
  }

  const maxSourceCount = limits.maxSourceCount || RAG_LIMITS.maxSourceCount;
  const minSourceCount = limits.minSourceCount || RAG_LIMITS.minSourceCount;
  const bestScore = Number(scoredChunks[0].score) || 0;
  const strongScoreCutoff = Math.max(
    RAG_LIMITS.minRelevance,
    bestScore - RAG_LIMITS.relevanceScoreDrop,
  );
  const selected = [];
  const seenReviews = new Set();

  appendChunksAboveScore({
    scoredChunks,
    selected,
    seenReviews,
    scoreFloor: strongScoreCutoff,
    maxSourceCount,
  });

  appendChunksAboveScore({
    scoredChunks,
    selected,
    seenReviews,
    scoreFloor: RAG_LIMITS.minRelevance,
    maxSourceCount,
  });

  if (selected.length >= minSourceCount) {
    return selected;
  }

  appendChunksAboveScore({
    scoredChunks,
    selected,
    seenReviews,
    scoreFloor: RAG_LIMITS.sourceScoreFloor,
    maxSourceCount,
    stopAtCount: minSourceCount,
  });

  return selected;
}

function appendChunksAboveScore({
  scoredChunks,
  selected,
  seenReviews,
  scoreFloor,
  maxSourceCount,
  stopAtCount = maxSourceCount,
}) {
  for (const chunk of scoredChunks) {
    if (selected.length >= maxSourceCount || selected.length >= stopAtCount) {
      return;
    }

    if ((Number(chunk.score) || 0) < scoreFloor) {
      continue;
    }

    const reviewKey = reviewKeyForChunk(chunk);

    if (seenReviews.has(reviewKey)) {
      continue;
    }

    seenReviews.add(reviewKey);
    selected.push(chunk);
  }
}

function buildQueryFilter(analysis, query) {
  const filter = {
    intent: analysis?.queryIntent || "neutral",
    sentimentLabels: analysis?.sentimentLabels || null,
    minRating: null,
    maxRating: null,
  };
  const normalizedQuery = String(query || "").toLowerCase();

  if (/\b(1|one)[-\s]?star\b/.test(normalizedQuery) || /\blow(?:est)? rated\b/.test(normalizedQuery)) {
    filter.maxRating = 2;
  } else if (/\b(2|two)[-\s]?star\b/.test(normalizedQuery)) {
    filter.minRating = 1.5;
    filter.maxRating = 2.5;
  } else if (/\b(3|three)[-\s]?star\b/.test(normalizedQuery)) {
    filter.minRating = 2.5;
    filter.maxRating = 3.5;
  } else if (/\b(4|four)[-\s]?star\b/.test(normalizedQuery)) {
    filter.minRating = 3.5;
    filter.maxRating = 4.5;
  } else if (/\b(5|five)[-\s]?star\b/.test(normalizedQuery) || /\bhigh(?:est)? rated\b/.test(normalizedQuery)) {
    filter.minRating = 4;
  }

  return filter;
}

function metadataRelevanceScore(filter, chunk) {
  const metadata = chunk.metadata || {};
  const label = String(metadata.sentiment_label || "mixed").toLowerCase();
  const text = String(chunk.text || "");

  if (filter.intent === "negative") {
    if (label === "negative") {
      return 1;
    }

    if (label === "mixed") {
      return NEGATIVE_SIGNAL.test(text) ? 0.7 : 0.1;
    }

    return 0;
  }

  if (filter.intent === "positive") {
    if (label === "positive") {
      return 1;
    }

    if (label === "mixed") {
      return POSITIVE_SIGNAL.test(text) ? 0.55 : 0.15;
    }

    return 0;
  }

  if (filter.intent === "balanced") {
    return label === "mixed" ? 0.8 : 0.45;
  }

  return 0.5;
}

function applyQueryFilter(chunks, filter) {
  return chunks.filter((chunk) => {
    const metadata = chunk.metadata || {};
    const label = String(metadata.sentiment_label || "mixed").toLowerCase();
    const text = String(chunk.text || "");

    if (filter.intent === "negative") {
      if (label === "negative") {
        return true;
      }

      return label === "mixed" && NEGATIVE_SIGNAL.test(text);
    }

    if (filter.intent === "positive") {
      if (label === "positive") {
        return true;
      }

      return label === "mixed" && POSITIVE_SIGNAL.test(text);
    }

    if (filter.sentimentLabels && !filter.sentimentLabels.includes(label)) {
      return false;
    }

    if (filter.minRating !== null || filter.maxRating !== null) {
      const rating = normalizedRating(metadata);

      if (rating === null) {
        return false;
      }

      if (filter.minRating !== null && rating < filter.minRating) {
        return false;
      }

      if (filter.maxRating !== null && rating > filter.maxRating) {
        return false;
      }
    }

    return true;
  });
}

function focusCandidatesBySubjectTerms(candidates, subjectTerms, requireSubjectMatch) {
  if (!subjectTerms.length || !candidates.length) {
    return candidates;
  }

  const focusedCandidates = candidates.filter((chunk) => (
    textMatchesAnySubjectTerm(chunk.text, subjectTerms)
  ));

  if (focusedCandidates.length || requireSubjectMatch) {
    return focusedCandidates;
  }

  return candidates;
}

function subjectTermsForQuery(queryTerms) {
  return queryTerms.filter((term) => !QUERY_INTENT_ONLY_TERMS.has(term));
}

function textMatchesAnySubjectTerm(text, subjectTerms) {
  const normalizedText = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")} `;

  return subjectTerms.some((term) => {
    const aliases = QUERY_TERM_ALIASES[term] || [term];
    return aliases.some((alias) => normalizedText.includes(` ${alias} `));
  });
}

function normalizedRating(metadata) {
  const rating = Number(metadata.rating);

  if (!Number.isFinite(rating)) {
    return null;
  }

  const ratingMax = Number(metadata.rating_max) || 5;
  return (rating / ratingMax) * 5;
}

function cosineSimilarity(left, right) {
  if (!left?.length || !right?.length || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]) || 0;
    const rightValue = Number(right[index]) || 0;

    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function lexicalOverlapScore(queryTerms, text) {
  if (!queryTerms.length) {
    return 0;
  }

  const textTerms = new Set(meaningfulTerms(text));
  const matches = queryTerms.filter((term) => textTerms.has(term)).length;

  return matches / queryTerms.length;
}

function meaningfulTerms(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !RETRIEVAL_STOP_WORDS.has(term));
}

function reviewKeyForChunk(chunk) {
  return String(
    chunk.reviewId ||
    chunk.metadata?.review_index ||
    chunk.id ||
    chunk.text,
  );
}

function clamp01(value) {
  return Math.min(Math.max(Number(value) || 0, 0), 1);
}
