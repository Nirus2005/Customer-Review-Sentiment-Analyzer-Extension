import {
  calculateReviewConfidence,
} from "./confidenceScoring.js";
import {
  collectReviewContainers,
  closestReviewContainer,
  extractReviewMetadata,
  reviewTextFromContainer,
} from "./domReviewExtractor.js";
import {
  queryAllWithin,
  resolveScrapeRoot,
} from "./domUtils.js";
import {
  extractJsonLdReviews,
} from "./jsonLdExtractor.js";
import {
  createSeenTracker,
  isDuplicateReview,
  rememberReview,
} from "./reviewDedupe.js";
import {
  FALLBACK_TEXT_SELECTORS,
} from "./selectors.js";
import {
  cleanCandidateText,
  isUsefulReviewText,
} from "./textUtils.js";
import {
  detectRepeatedStructures,
} from "./structuralDetector.js";

const DEFAULT_CONFIDENCE_THRESHOLD = 0.52;

export function scrapeReviewsFromPage(limit, options = {}) {
  const runtimeOptions = normalizeRuntimeOptions(options);
  const scrapeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Number(limit)
    : Number.POSITIVE_INFINITY;
  const confidenceThreshold = Number.isFinite(Number(runtimeOptions.confidenceThreshold))
    ? Number(runtimeOptions.confidenceThreshold)
    : DEFAULT_CONFIDENCE_THRESHOLD;
  const debugEnabled = Boolean(runtimeOptions.debug);
  const debugEvents = [];
  const selectionOnly = Boolean(runtimeOptions.selectionOnly || runtimeOptions.mode === "selection");
  const root = resolveScrapeRoot(runtimeOptions, selectionOnly);
  const selectionIntersectsElement = createSelectionIntersectsElement(selectionOnly);
  const seen = createSeenTracker();
  const reviews = [];

  function debugLog(message, details = {}) {
    if (!debugEnabled) {
      return;
    }

    const entry = {
      message,
      ...details,
    };

    debugEvents.push(entry);

    if (typeof console !== "undefined" && typeof console.debug === "function") {
      console.debug("[Verdict scraper]", message, details);
    }
  }

  function scrapeMetadata() {
    return {
      selectionOnly,
      selectionFound: Boolean(selectionOnly && root),
      usedSelection: Boolean(selectionOnly && root),
      ...(debugEnabled ? { debug: debugEvents } : {}),
    };
  }

  function finish(hitLimit = false) {
    return {
      reviews,
      hitLimit,
      ...scrapeMetadata(),
    };
  }

  if (!root) {
    return finish(false);
  }

  // JSON-LD is the highest-confidence source and runs before DOM scraping.
  if (!selectionOnly || runtimeOptions.includeJsonLdInSelection) {
    for (const review of extractJsonLdReviews(root, { debugLog })) {
      addReviewCandidate({
        review,
        score: {
          value: 0.98,
          positive: [{ amount: 0.98, reason: "JSON-LD Review schema" }],
          negative: [],
          threshold: confidenceThreshold,
        },
      });

      if (limitReached()) {
        return finish(true);
      }
    }
  }

  for (const structuralCandidate of detectRepeatedStructures(root, {
    debugLog,
    reviewTextFromContainer,
    runtimeOptions,
  })) {
    if (!candidateIntersectsSelection(structuralCandidate.element)) {
      continue;
    }

    addReviewCandidate(buildContainerCandidate(
      structuralCandidate.element,
      "structural",
      structuralCandidate.group,
    ));

    if (limitReached()) {
      return finish(true);
    }
  }

  for (const container of collectReviewContainers(root, {
    debugLog,
    reviewTextFromContainer,
  })) {
    if (!candidateIntersectsSelection(container)) {
      continue;
    }

    addReviewCandidate(buildContainerCandidate(container, "legacy-selector"));

    if (limitReached()) {
      return finish(true);
    }
  }

  for (const selector of FALLBACK_TEXT_SELECTORS) {
    for (const element of queryAllWithin(root, selector)) {
      if (closestReviewContainer(element) !== element) {
        continue;
      }

      if (!candidateIntersectsSelection(element)) {
        continue;
      }

      addReviewCandidate(buildElementCandidate(element, "fallback-text"));

      if (limitReached()) {
        return finish(true);
      }
    }
  }

  if (selectionOnly && !reviews.length && runtimeOptions.allowSelectionTextFallback !== false) {
    addReviewCandidate(buildSelectionTextCandidate());
  }

  return finish(false);

  function buildContainerCandidate(container, strategy, structuralGroup = null) {
    const text = reviewTextFromContainer(container);

    if (!isUsefulReviewText(text)) {
      return null;
    }

    const metadata = extractReviewMetadata(container);
    const score = calculateReviewConfidence(
      {
        element: container,
        metadata,
        strategy,
        structuralGroup,
        text,
      },
      { confidenceThreshold },
    );

    return {
      review: {
        text,
        ...metadata,
        source_id: container.getAttribute("data-review-id") || container.id || null,
        extraction_strategy: strategy,
        confidence_score: score.value,
      },
      score,
    };
  }

  function buildElementCandidate(element, strategy) {
    const text = cleanCandidateText(element.innerText || element.textContent || "");

    if (!isUsefulReviewText(text)) {
      return null;
    }

    const metadata = extractReviewMetadata(element);
    const score = calculateReviewConfidence(
      {
        element,
        metadata,
        strategy,
        structuralGroup: null,
        text,
      },
      { confidenceThreshold },
    );

    return {
      review: {
        text,
        ...metadata,
        extraction_strategy: strategy,
        confidence_score: score.value,
      },
      score,
    };
  }

  function buildSelectionTextCandidate() {
    const text = selectedTextFromPage();

    if (!isUsefulReviewText(text)) {
      return null;
    }

    const score = {
      value: Math.max(confidenceThreshold, 0.78),
      positive: [{ amount: 0.78, reason: "Selected text fallback" }],
      negative: [],
      threshold: confidenceThreshold,
    };

    return {
      review: {
        text,
        extraction_strategy: "selection-text",
        confidence_score: score.value,
      },
      score,
    };
  }

  function addReviewCandidate(candidate) {
    if (!candidate?.review?.text) {
      return false;
    }

    if (candidate.score.value < confidenceThreshold) {
      debugLog("Rejected review candidate below confidence threshold.", {
        strategy: candidate.review.extraction_strategy,
        confidence: candidate.score.value,
        threshold: confidenceThreshold,
        textPreview: candidate.review.text.slice(0, 120),
        breakdown: candidate.score,
      });
      return false;
    }

    if (isDuplicateReview(candidate.review.text, seen)) {
      debugLog("Rejected duplicate review candidate.", {
        strategy: candidate.review.extraction_strategy,
        confidence: candidate.score.value,
        textPreview: candidate.review.text.slice(0, 120),
      });
      return false;
    }

    rememberReview(candidate.review.text, seen);
    reviews.push(debugEnabled
      ? {
        ...candidate.review,
        confidence_breakdown: candidate.score,
      }
      : candidate.review);

    debugLog("Accepted review candidate.", {
      strategy: candidate.review.extraction_strategy,
      confidence: candidate.score.value,
      textPreview: candidate.review.text.slice(0, 120),
      breakdown: candidate.score,
    });

    return true;
  }

  function limitReached() {
    return reviews.length >= scrapeLimit;
  }

  function candidateIntersectsSelection(element) {
    return !selectionIntersectsElement || selectionIntersectsElement(element);
  }
}

export function scrapeReviewsFromSelection(limit, options = {}) {
  return scrapeReviewsFromPage(limit, {
    ...(options && typeof options === "object" ? options : {}),
    selectionOnly: true,
  });
}

function normalizeRuntimeOptions(options) {
  const globalConfig = (
    typeof globalThis !== "undefined" &&
    globalThis.__VERDICT_SCRAPER_CONFIG__ &&
    typeof globalThis.__VERDICT_SCRAPER_CONFIG__ === "object"
  )
    ? globalThis.__VERDICT_SCRAPER_CONFIG__
    : {};

  return {
    ...globalConfig,
    ...(options && typeof options === "object" ? options : {}),
  };
}

function createSelectionIntersectsElement(selectionOnly) {
  if (!selectionOnly || typeof window === "undefined" || typeof window.getSelection !== "function") {
    return null;
  }

  const selection = window.getSelection();
  const selectedText = cleanCandidateText(selection?.toString() || "");

  if (!selection || selection.rangeCount === 0 || !selectedText) {
    return () => false;
  }

  const ranges = [];

  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      ranges.push(selection.getRangeAt(index));
    } catch {
      // Ignore invalid browser selection ranges.
    }
  }

  if (!ranges.length) {
    return () => false;
  }

  return (element) => ranges.some((range) => rangeIntersectsElement(range, element, selectedText));
}

function rangeIntersectsElement(range, element, selectedText) {
  if (!element) {
    return false;
  }

  try {
    return range.intersectsNode(element);
  } catch {
    const elementText = cleanCandidateText(element.innerText || element.textContent || "");
    const selectedSnippet = selectedText.slice(0, 120);

    return Boolean(
      elementText &&
      selectedSnippet &&
      (elementText.includes(selectedSnippet) || selectedText.includes(elementText.slice(0, 120))),
    );
  }
}

function selectedTextFromPage() {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") {
    return "";
  }

  return cleanCandidateText(window.getSelection()?.toString() || "");
}
