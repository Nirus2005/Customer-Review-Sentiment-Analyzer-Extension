import {
  queryAllWithin,
  safeRect,
} from "./domUtils.js";
import {
  cleanCandidateText,
  datePatterns,
  isUsefulReviewText,
} from "./textUtils.js";

export function calculateReviewConfidence({
  element,
  metadata,
  strategy,
  structuralGroup,
  text,
}, {
  confidenceThreshold,
}) {
  let value = 0;
  const positive = [];
  const negative = [];

  function add(amount, reason) {
    value += amount;
    positive.push({
      amount,
      reason,
    });
  }

  function subtract(amount, reason) {
    value -= amount;
    negative.push({
      amount,
      reason,
    });
  }

  const normalized = cleanCandidateText(text);
  const lowerText = normalized.toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);
  const visual = getVisualSignals(element, normalized);

  if (strategy === "json-ld") {
    add(0.66, "JSON-LD Review schema");
  } else if (strategy === "legacy-selector") {
    add(0.42, "existing review selector matched");
  } else if (strategy === "fallback-text") {
    add(0.36, "existing review text selector matched");
  } else if (strategy === "structural") {
    add(0.14, "candidate came from repeated structure detection");
  }

  if (isUsefulReviewText(normalized)) {
    add(0.12, "substantial review-like text");
  }

  if (words.length >= 12 && words.length <= 220) {
    add(0.07, "medium or long review text");
  }

  if (Number.isFinite(Number(metadata.rating))) {
    add(0.14, "rating signal");
  } else if (hasStarRatingIndicator(element, normalized)) {
    add(0.08, "star rating indicator");
  }

  if (metadata.date || datePatterns().some((pattern) => pattern.test(normalized))) {
    add(0.07, "date signal");
  }

  if (metadata.author || /\b(?:by|from|reviewed by)\s+[A-Z][A-Za-z0-9_. '-]{1,60}\b/.test(normalized)) {
    add(0.05, "author signal");
  }

  if (metadata.helpful_votes !== undefined || metadata.upvotes !== undefined || /\b(?:helpful|upvote|like|found this helpful)\b/i.test(normalized)) {
    add(0.05, "helpful vote signal");
  }

  if (hasReviewRelatedAttributes(element)) {
    add(0.11, "review-related attributes");
  }

  if (structuralGroup) {
    if (structuralGroup.substantialSiblingCount >= 5) {
      add(0.22, "5 or more siblings share this structure");
    } else if (structuralGroup.substantialSiblingCount >= 3) {
      add(0.12, "3 or more siblings share this structure");
    }

    if (structuralGroup.stackedScore >= 0.66) {
      add(0.14 * structuralGroup.stackedScore, "siblings are visually stacked");
    }

    if (structuralGroup.similarSizeScore >= 0.6) {
      add(0.07 * structuralGroup.similarSizeScore, "sibling cards have similar dimensions");
    }

    if (structuralGroup.sectionAreaRatio >= 0.2) {
      add(0.05, "review section occupies significant page area");
    }
  }

  if (visual.textDensity >= 0.0016) {
    add(0.05, "high text density");
  }

  if (visual.contentAreaRatio >= 0.02) {
    add(0.04, "meaningful content card size");
  }

  if (strategy !== "structural" && countUsefulChildBlocks(element) >= 3) {
    subtract(0.18, "container appears to hold multiple review blocks");
  }

  if (isNavigationElement(element) || /\b(?:menu|navigation|breadcrumb)\b/i.test(lowerText)) {
    subtract(0.24, "navigation or menu area");
  }

  if (/\b(?:sort by|filter by|filters?|refine|departments?|categories|price range)\b/i.test(lowerText)) {
    subtract(0.22, "sorting or filter controls");
  }

  if (/\b(?:specifications?|technical details|model number|product details|warranty|seller|delivery|add to cart|buy now)\b/i.test(lowerText)) {
    subtract(0.15, "product specs or commerce controls");
  }

  if (/\b(?:sponsored|advertisement|ad feedback|promoted)\b/i.test(lowerText)) {
    subtract(0.18, "advertising content");
  }

  if (visual.linkOrButtonTextRatio >= 0.55) {
    subtract(0.16, "too much link or button text");
  }

  if (visual.isTinyWidget) {
    subtract(0.12, "tiny widget dimensions");
  }

  if (visual.looksLikeSidebar) {
    subtract(0.09, "sidebar-like placement");
  }

  value = Math.max(0, Math.min(1, value));

  return {
    value: Number(value.toFixed(3)),
    positive,
    negative,
    threshold: confidenceThreshold,
  };
}

function getVisualSignals(element, text) {
  const rect = safeRect(element);
  const textLength = cleanCandidateText(text).length;
  const area = Math.max(1, rect.width * rect.height);
  const linkAndButtonText = queryAllWithin(element, "a,button,[role='button']")
    .map((node) => cleanCandidateText(node.innerText || node.textContent || ""))
    .join(" ");
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;

  return {
    contentAreaRatio: Math.min(1, area / Math.max(1, viewportWidth * viewportHeight)),
    isTinyWidget: rect.width < 140 || rect.height < 32,
    linkOrButtonTextRatio: cleanCandidateText(linkAndButtonText).length / Math.max(1, textLength),
    looksLikeSidebar: rect.width > 0 && rect.width < Math.max(260, viewportWidth * 0.24) && rect.left < viewportWidth * 0.18 && rect.height > viewportHeight * 0.45,
    textDensity: textLength / area,
  };
}

function hasStarRatingIndicator(element, text) {
  const attributeText = [
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("title"),
    text,
  ]
    .filter(Boolean)
    .join(" ");

  return /(?:star|rating|\u2605|\u2b50|\d+(?:\.\d+)?\s*\/\s*5)/i.test(attributeText);
}

function hasReviewRelatedAttributes(element) {
  if (!element?.attributes) {
    return false;
  }

  const attributeText = Array.from(element.attributes)
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .join(" ");

  return /\b(?:review|comment|rating|stars?|testimonial|feedback)\b/i.test(attributeText);
}

function isNavigationElement(element) {
  const tag = element?.tagName?.toLowerCase();
  const role = element?.getAttribute?.("role") || "";

  return ["nav", "header", "footer", "aside", "menu", "form"].includes(tag) ||
    /\b(?:navigation|menubar|toolbar|search|banner|contentinfo|complementary)\b/i.test(role);
}

function countUsefulChildBlocks(element) {
  if (!element?.children || element.children.length < 3) {
    return 0;
  }

  return Array.from(element.children)
    .slice(0, 12)
    .filter((child) => isUsefulReviewText(cleanCandidateText(child.innerText || child.textContent || "")))
    .length;
}
