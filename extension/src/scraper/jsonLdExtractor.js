import {
  queryAllWithin,
} from "./domUtils.js";
import {
  cleanCandidateText,
  extractRatingFromText,
  firstString,
  isUsefulReviewText,
  joinUniqueText,
  parseCompactNumber,
} from "./textUtils.js";

export function extractJsonLdReviews(scope, { debugLog }) {
  const scripts = queryAllWithin(scope || document, "script[type='application/ld+json']");
  const reviews = [];
  const visited = typeof WeakSet !== "undefined" ? new WeakSet() : null;

  function visit(node, context = {}) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (visited) {
      if (visited.has(node)) {
        return;
      }
      visited.add(node);
    }

    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, context));
      return;
    }

    const nextContext = {
      aggregateRating: node.aggregateRating || context.aggregateRating || null,
      itemName: firstString(node.name, node.headline, context.itemName),
    };

    if (isJsonLdType(node, "Review")) {
      const review = jsonLdReviewToReview(node, context);

      if (review) {
        reviews.push(review);
      }
    }

    for (const review of asArray(node.review)) {
      const extractedReview = jsonLdReviewToReview(review, nextContext);

      if (extractedReview) {
        reviews.push(extractedReview);
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        visit(value, nextContext);
      }
    }
  }

  scripts.forEach((script, index) => {
    const rawJson = String(script.textContent || "").trim();

    if (!rawJson) {
      return;
    }

    try {
      visit(JSON.parse(rawJson));
    } catch (error) {
      debugLog("Skipped invalid JSON-LD block.", {
        strategy: "json-ld",
        blockIndex: index,
        error: error?.message || String(error),
      });
    }
  });

  return reviews.map((review, index) => ({
    ...review,
    source_id: review.source_id || `json-ld-${index + 1}`,
    extraction_strategy: "json-ld",
    confidence_score: 0.98,
  }));
}

function jsonLdReviewToReview(review, context = {}) {
  if (!review || typeof review !== "object") {
    return null;
  }

  const title = firstString(review.name, review.headline, review.reviewTitle);
  const body = firstString(review.reviewBody, review.description, review.text);
  const text = joinUniqueText([title, body]);

  if (!isUsefulReviewText(text)) {
    return null;
  }

  const rating = extractJsonLdRating(review.reviewRating || review.rating || review.aggregateRating);
  const aggregate = extractJsonLdAggregateRating(review.aggregateRating || context.aggregateRating);
  const author = normalizeJsonLdAuthor(review.author);
  const date = firstString(review.datePublished, review.dateCreated, review.dateModified);
  const reviewObject = {
    text,
  };

  if (title) {
    reviewObject.title = title;
  }

  if (author) {
    reviewObject.author = author;
  }

  if (date) {
    reviewObject.date = date;
  }

  if (context.itemName) {
    reviewObject.item_name = context.itemName;
  }

  Object.assign(reviewObject, rating, aggregate);

  return reviewObject;
}

function extractJsonLdRating(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "number" || typeof value === "string") {
    return normalizeJsonLdRatingValue(value, null);
  }

  if (typeof value !== "object") {
    return {};
  }

  return normalizeJsonLdRatingValue(
    firstString(value.ratingValue, value.value, value.name),
    firstString(value.bestRating, value.worstRating ? null : 5),
  );
}

function normalizeJsonLdRatingValue(value, bestRating) {
  const parsedFromText = extractRatingFromText(value);

  if (Number.isFinite(Number(parsedFromText.rating))) {
    return parsedFromText;
  }

  const rating = Number(String(value || "").match(/\d+(?:\.\d+)?/)?.[0]);

  if (!Number.isFinite(rating)) {
    return {};
  }

  const maxRating = Number(bestRating) || 5;

  return {
    rating,
    rating_max: maxRating,
  };
}

function extractJsonLdAggregateRating(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const ratingText = firstString(value.ratingValue, value.value);
  const parsedRating = extractRatingFromText(ratingText);
  const aggregateRating = Number.isFinite(Number(parsedRating.rating))
    ? Number(parsedRating.rating)
    : Number(ratingText);
  const aggregateRatingMax = Number(parsedRating.rating_max || firstString(value.bestRating, 5)) || 5;
  const aggregateRatingCount = parseCompactNumber(firstString(value.ratingCount, value.reviewCount));
  const metadata = {};

  if (Number.isFinite(aggregateRating)) {
    metadata.aggregate_rating = aggregateRating;
    metadata.aggregate_rating_max = aggregateRatingMax;
  }

  if (aggregateRatingCount !== null) {
    metadata.aggregate_rating_count = aggregateRatingCount;
  }

  return metadata;
}

function normalizeJsonLdAuthor(author) {
  if (Array.isArray(author)) {
    return author.map(normalizeJsonLdAuthor).filter(Boolean).join(", ") || null;
  }

  if (author && typeof author === "object") {
    return firstString(author.name, author.alternateName, author.givenName);
  }

  return firstString(author);
}

function isJsonLdType(node, type) {
  return asArray(node?.["@type"])
    .map((item) => String(item).toLowerCase())
    .includes(type.toLowerCase());
}

function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}
