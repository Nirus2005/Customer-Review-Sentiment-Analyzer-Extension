import {
  AUTHOR_SELECTORS,
  CLOSEST_REVIEW_CONTAINER_SELECTORS,
  DATE_SELECTORS,
  DOWNVOTE_SELECTORS,
  RATING_SELECTORS,
  REVIEW_CONTAINER_SELECTORS,
  REVIEW_TEXT_SELECTORS,
  TITLE_SELECTORS,
  UPVOTE_SELECTORS,
} from "./selectors.js";
import {
  queryAllWithin,
  queryAllWithSelf,
} from "./domUtils.js";
import {
  cleanCandidateText,
  datePatterns,
  extractRatingFromText,
  extractTextCount,
  isUsefulReviewText,
  normalizeDedupText,
  parseCompactNumber,
} from "./textUtils.js";

export function closestReviewContainer(element) {
  return (
    element.closest(CLOSEST_REVIEW_CONTAINER_SELECTORS.join(",")) ||
    element
  );
}

export function collectReviewContainers(scope, {
  debugLog,
  reviewTextFromContainer: textFromContainer = reviewTextFromContainer,
}) {
  const containers = [];
  const seenKeys = new Set();

  function addContainer(container, reason) {
    if (!container || container === document.body || container === document.documentElement) {
      return;
    }

    const text = textFromContainer(container);

    if (!isUsefulReviewText(text)) {
      return;
    }

    const key = (
      container.getAttribute("data-review-id") ||
      container.id ||
      normalizeDedupText(text)
    );

    if (seenKeys.has(key) || containers.some((existingContainer) => existingContainer.contains(container))) {
      return;
    }

    for (let index = containers.length - 1; index >= 0; index -= 1) {
      if (container.contains(containers[index])) {
        containers.splice(index, 1);
      }
    }

    seenKeys.add(key);
    containers.push(container);
    debugLog("Legacy selector found a possible review container.", {
      strategy: "legacy-selector",
      reason,
      textPreview: text.slice(0, 120),
    });
  }

  for (const selector of REVIEW_CONTAINER_SELECTORS) {
    queryAllWithSelf(scope, selector).forEach((container) => addContainer(container, selector));
  }

  // Keep the rating climb fallback for pages where only the rating badge is stable.
  for (const selector of RATING_SELECTORS) {
    queryAllWithin(scope, selector).forEach((ratingEl) => {
      let container = ratingEl.parentElement;

      for (let i = 0; i < 5 && container; i += 1) {
        if (container.innerText && container.innerText.length > 50) {
          addContainer(container, `rating-climb:${selector}`);
        }
        container = container.parentElement;
      }
    });
  }

  return containers;
}

export function reviewTextFromContainer(container) {
  const parts = [];
  const seenParts = new Set();

  for (const candidate of queryAllWithin(container, REVIEW_TEXT_SELECTORS.join(","))) {
    const text = cleanCandidateText(candidate.innerText || candidate.textContent || "");
    const key = text.toLowerCase();

    if (isUsefulReviewText(text) && !seenParts.has(key)) {
      seenParts.add(key);
      parts.push(text);
    }
  }

  const combinedText = parts.join(" ").trim();

  if (isUsefulReviewText(combinedText)) {
    return combinedText;
  }

  return cleanCandidateText(container.innerText || container.textContent || "");
}

export function extractReviewMetadata(element) {
  const container = closestReviewContainer(element);
  const containerText = cleanCandidateText(container.innerText || container.textContent || "");
  const metadata = {};
  const ratingElement = container.querySelector(RATING_SELECTORS.join(","));
  const ratingText = [
    ratingElement?.getAttribute("content"),
    ratingElement?.getAttribute("aria-label"),
    ratingElement?.getAttribute("title"),
    ratingElement?.innerText,
    container.getAttribute("aria-label"),
    containerText,
  ]
    .filter(Boolean)
    .join(" ");

  Object.assign(metadata, extractRatingFromText(ratingText));

  const upvotes = extractElementNumber(
    container,
    UPVOTE_SELECTORS,
    ["dislike", "downvote"],
  ) ?? extractTextCount(containerText, [
    /(\d[\d,.]*\s*[kKmM]?)\s*(?:people\s+found\s+this\s+helpful|found\s+this\s+helpful|helpful|upvotes?|likes?)/i,
  ]);

  if (upvotes !== null) {
    metadata.upvotes = upvotes;
  }

  const downvotes = extractElementNumber(
    container,
    DOWNVOTE_SELECTORS,
  ) ?? extractTextCount(containerText, [
    /(\d[\d,.]*\s*[kKmM]?)\s*(?:downvotes?|dislikes?)/i,
  ]);

  if (downvotes !== null) {
    metadata.downvotes = downvotes;
  }

  const helpfulMatch = containerText.match(/(\d[\d,.]*\s*[kKmM]?)\s+(?:people\s+)?(?:found\s+this\s+)?helpful/i);

  if (helpfulMatch) {
    const helpfulVotes = parseCompactNumber(helpfulMatch[1]);

    if (helpfulVotes !== null) {
      metadata.helpful_votes = helpfulVotes;
      metadata.helpfulness = `${helpfulVotes} helpful`;
    }
  }

  const reviewDate = extractReviewDate(container, containerText);

  if (reviewDate) {
    metadata.date = reviewDate;
  }

  const reviewTitle = extractReviewTitle(container);

  if (reviewTitle) {
    metadata.title = reviewTitle;
  }

  const author = extractReviewAuthor(container, containerText);

  if (author) {
    metadata.author = author;
  }

  return metadata;
}

function extractElementNumber(container, selectors, blockedWords = []) {
  const candidates = queryAllWithin(container, selectors.join(","));

  for (const candidate of candidates) {
    const text = [
      candidate.getAttribute("aria-label"),
      candidate.getAttribute("title"),
      candidate.getAttribute("data-count"),
      candidate.getAttribute("data-testid"),
      candidate.innerText,
      candidate.textContent,
    ]
      .filter(Boolean)
      .join(" ");
    const lowerText = text.toLowerCase();

    if (blockedWords.some((word) => lowerText.includes(word))) {
      continue;
    }

    const count = parseCompactNumber(text);

    if (count !== null) {
      return count;
    }
  }

  return null;
}

function extractReviewDate(container, containerText) {
  const dateElement = container.querySelector(DATE_SELECTORS.join(","));
  const explicitDate = [
    dateElement?.getAttribute("datetime"),
    dateElement?.getAttribute("title"),
    dateElement?.getAttribute("aria-label"),
    dateElement?.innerText,
  ]
    .filter(Boolean)
    .map((value) => String(value).replace(/\s+/g, " ").trim())
    .find(Boolean);

  if (explicitDate) {
    return explicitDate;
  }

  for (const pattern of datePatterns()) {
    const match = containerText.match(pattern);

    if (match) {
      return match[0].replace(/\s+/g, " ").trim();
    }
  }

  return null;
}

function extractReviewTitle(container) {
  const titleElement = container.querySelector(TITLE_SELECTORS.join(","));
  const title = cleanCandidateText(
    titleElement?.getAttribute("content") ||
    titleElement?.getAttribute("title") ||
    titleElement?.innerText ||
    titleElement?.textContent ||
    "",
  );

  if (title.length >= 3 && title.length <= 160) {
    return title;
  }

  return null;
}

function extractReviewAuthor(container, containerText) {
  const authorElement = container.querySelector(AUTHOR_SELECTORS.join(","));
  const explicitAuthor = cleanCandidateText(
    authorElement?.getAttribute("content") ||
    authorElement?.getAttribute("aria-label") ||
    authorElement?.getAttribute("title") ||
    authorElement?.innerText ||
    authorElement?.textContent ||
    "",
  )
    .replace(/^(?:by|from|author)\s+/i, "")
    .trim();

  if (looksLikeAuthorName(explicitAuthor)) {
    return explicitAuthor;
  }

  const authorMatch = containerText.match(/\b(?:by|from|reviewed by)\s+([A-Z][A-Za-z0-9_. '-]{1,60})\b/);

  if (authorMatch && looksLikeAuthorName(authorMatch[1])) {
    return authorMatch[1].trim();
  }

  return null;
}

function looksLikeAuthorName(value) {
  const text = cleanCandidateText(value);

  if (text.length < 2 || text.length > 80) {
    return false;
  }

  return !/\b(?:review|rating|stars?|verified|purchase|helpful|seller|customer reviews|sort|filter)\b/i.test(text);
}
