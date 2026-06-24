import { RAG_LIMITS } from "../constants/ragConfig.js";
import { RETRIEVAL_STOP_WORDS } from "../constants/queryLexicon.js";
import {
  NEGATIVE_SIGNAL,
  POSITIVE_SIGNAL,
} from "./reviewProcessing.js";

const CONTRAST_SIGNAL = /\b(?:although|but|except|however|though|while|yet)\b/i;

export function prepareReviewIndexPlan(reviews, sessionId, options = {}) {
  const identifiedReviews = reviews.map((review, index) => withReviewIdentity(review, sessionId, index));
  const metricReviews = identifiedReviews.map(estimateReviewSentiment);
  const requestedInitialLimit = Number(options.initialReviewLimit);
  const configuredInitialLimit = Number.isFinite(requestedInitialLimit) && requestedInitialLimit > 0
    ? requestedInitialLimit
    : RAG_LIMITS.maxInitialIndexedReviews;
  const initialIndexLimit = Math.max(1, Math.min(
    Math.round(configuredInitialLimit),
    RAG_LIMITS.maxInitialIndexedReviews,
  ));

  if (identifiedReviews.length <= Math.min(RAG_LIMITS.fullIndexReviewLimit, initialIndexLimit)) {
    return {
      initialReviews: identifiedReviews,
      backlogReviews: [],
      metricReviews,
      isProgressive: false,
      unqueuedReviewCount: 0,
    };
  }

  const initialLimit = Math.min(initialIndexLimit, identifiedReviews.length);
  const priorityLimit = Math.max(1, Math.floor(initialLimit * 0.7));
  const scoredReviews = identifiedReviews
    .map((review) => ({
      review,
      score: reviewPriorityScore(review),
    }))
    .sort((left, right) => right.score - left.score);
  const selectedIds = new Set(scoredReviews.slice(0, priorityLimit).map((item) => item.review.id));
  const remainingByPriority = scoredReviews
    .filter((item) => !selectedIds.has(item.review.id))
    .map((item) => item.review)
    .sort((left, right) => left.original_index - right.original_index);

  takeEvenSample(remainingByPriority, initialLimit - selectedIds.size)
    .forEach((review) => selectedIds.add(review.id));

  const initialReviews = identifiedReviews.filter((review) => selectedIds.has(review.id));
  const allBacklogReviews = identifiedReviews
    .filter((review) => !selectedIds.has(review.id))
    .map(estimateReviewSentiment);
  const backlogReviews = allBacklogReviews.slice(0, RAG_LIMITS.maxStoredBacklogReviews);

  return {
    initialReviews,
    backlogReviews,
    metricReviews,
    isProgressive: true,
    unqueuedReviewCount: Math.max(0, allBacklogReviews.length - backlogReviews.length),
  };
}

export function selectBacklogReviewsForQuery(backlogReviews, query, analysis) {
  const reviews = Array.isArray(backlogReviews) ? backlogReviews : [];

  if (!reviews.length) {
    return {
      selectedReviews: [],
      remainingReviews: [],
    };
  }

  const queryTerms = meaningfulTerms(query);
  const ratingFilter = ratingFilterFromQuery(query);
  const scoredReviews = reviews
    .map((review, backlogIndex) => ({
      review,
      backlogIndex,
      score: queryReviewScore(review, queryTerms, ratingFilter, analysis),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  const selectedIds = new Set(scoredReviews
    .slice(0, RAG_LIMITS.maxLazyIndexedReviewsPerQuery)
    .map((item) => item.review.id));

  if (!selectedIds.size) {
    return {
      selectedReviews: [],
      remainingReviews: reviews,
    };
  }

  return {
    selectedReviews: reviews.filter((review) => selectedIds.has(review.id)),
    remainingReviews: reviews.filter((review) => !selectedIds.has(review.id)),
  };
}

export function estimateReviewSentiment(review) {
  const text = String(review?.text || "");
  const rating = normalizedRating(review);
  const hasPositiveSignal = POSITIVE_SIGNAL.test(text);
  const hasNegativeSignal = NEGATIVE_SIGNAL.test(text);
  const hasContrast = CONTRAST_SIGNAL.test(text);

  if (rating !== null && rating <= 2) {
    return sentimentReview(review, "negative", 0.78);
  }

  if ((hasPositiveSignal && hasNegativeSignal) || (hasContrast && (hasPositiveSignal || hasNegativeSignal))) {
    return sentimentReview(review, "mixed", 0.6);
  }

  if (hasNegativeSignal || (rating !== null && rating < 3)) {
    return sentimentReview(review, "negative", 0.66);
  }

  if (rating !== null && rating >= 4) {
    return sentimentReview(review, "positive", 0.7);
  }

  if (hasPositiveSignal) {
    return sentimentReview(review, "positive", 0.64);
  }

  return sentimentReview(review, "mixed", 0.5);
}

function withReviewIdentity(review, sessionId, index) {
  const sourceReviewId = review.id || review.source_id || null;

  return {
    ...review,
    id: `${sessionId}-review-${index + 1}`,
    source_id: sourceReviewId,
    original_index: Number.isInteger(review.original_index) ? review.original_index : index,
  };
}

function sentimentReview(review, label, score) {
  return {
    ...review,
    sentiment_label: label,
    sentiment_score: score,
  };
}

function reviewPriorityScore(review) {
  const text = String(review.text || "");
  const rating = normalizedRating(review);
  const wordCount = meaningfulTerms(text).length;
  let score = 0;

  if (rating !== null) {
    if (rating <= 2) score += 14;
    else if (rating <= 3) score += 7;
    else if (rating >= 4.5) score += 3;
  }

  if (NEGATIVE_SIGNAL.test(text)) score += 10;
  if (POSITIVE_SIGNAL.test(text)) score += 3;
  if (CONTRAST_SIGNAL.test(text)) score += 4;

  score += Math.min(helpfulnessScore(review), 6);
  score += Math.min(Math.max(wordCount - 6, 0) / 16, 5);
  score -= (Number(review.original_index) || 0) * 0.0001;

  return score;
}

function queryReviewScore(review, queryTerms, ratingFilter, analysis) {
  const text = String(review.text || "");
  const label = String(review.sentiment_label || "mixed").toLowerCase();
  const lexicalScore = lexicalOverlapScore(queryTerms, text);
  let score = lexicalScore * 10;

  if (ratingFilter && ratingMatches(review, ratingFilter)) {
    score += 8;
  } else if (ratingFilter) {
    score -= 6;
  }

  if (analysis?.sentimentLabels?.includes(label)) {
    score += label === "mixed" ? 4 : 7;
  } else if (analysis?.queryIntent === "balanced" && label === "mixed") {
    score += 4;
  } else if (analysis?.queryIntent === "overall") {
    score += 1;
  }

  if (analysis?.querySentiment === "negative" && NEGATIVE_SIGNAL.test(text)) {
    score += 5;
  }

  if (analysis?.querySentiment === "positive" && POSITIVE_SIGNAL.test(text)) {
    score += 5;
  }

  score += Math.min(helpfulnessScore(review), 4) * 0.5;
  return score;
}

function takeEvenSample(items, count) {
  if (count <= 0 || !items.length) {
    return [];
  }

  if (items.length <= count) {
    return items;
  }

  const selected = [];
  const selectedIndexes = new Set();
  const step = (items.length - 1) / Math.max(count - 1, 1);

  for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
    const itemIndex = Math.round(sampleIndex * step);

    if (!selectedIndexes.has(itemIndex)) {
      selectedIndexes.add(itemIndex);
      selected.push(items[itemIndex]);
    }
  }

  for (let index = 0; selected.length < count && index < items.length; index += 1) {
    if (!selectedIndexes.has(index)) {
      selectedIndexes.add(index);
      selected.push(items[index]);
    }
  }

  return selected;
}

function ratingFilterFromQuery(query) {
  const normalizedQuery = String(query || "").toLowerCase();

  if (/\b(1|one)[-\s]?star\b/.test(normalizedQuery) || /\blow(?:est)? rated\b/.test(normalizedQuery)) {
    return { max: 2 };
  }

  if (/\b(2|two)[-\s]?star\b/.test(normalizedQuery)) return { min: 1.5, max: 2.5 };
  if (/\b(3|three)[-\s]?star\b/.test(normalizedQuery)) return { min: 2.5, max: 3.5 };
  if (/\b(4|four)[-\s]?star\b/.test(normalizedQuery)) return { min: 3.5, max: 4.5 };
  if (/\b(5|five)[-\s]?star\b/.test(normalizedQuery) || /\bhigh(?:est)? rated\b/.test(normalizedQuery)) {
    return { min: 4 };
  }

  return null;
}

function ratingMatches(review, filter) {
  const rating = normalizedRating(review);

  if (rating === null) {
    return false;
  }

  if (filter.min !== undefined && rating < filter.min) {
    return false;
  }

  if (filter.max !== undefined && rating > filter.max) {
    return false;
  }

  return true;
}

function normalizedRating(review) {
  const rating = Number(review?.rating);

  if (!Number.isFinite(rating)) {
    return null;
  }

  const ratingMax = Number(review?.rating_max) || 5;
  return (rating / ratingMax) * 5;
}

function helpfulnessScore(review) {
  const values = [
    review.helpful_votes,
    review.upvotes,
    review.helpfulness_count,
  ].map(Number).filter(Number.isFinite);

  if (!values.length) {
    return 0;
  }

  return Math.log2(Math.max(...values) + 1);
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
