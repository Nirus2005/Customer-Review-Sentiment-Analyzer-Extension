const STAR_PATTERN = "\\u2605|\\u2b50";

export function parseCompactNumber(value) {
  const match = String(value || "")
    .replace(/,/g, "")
    .match(/(\d+(?:\.\d+)?)\s*([kKmM])?/);

  if (!match) {
    return null;
  }

  const multiplier = match[2]?.toLowerCase() === "m"
    ? 1_000_000
    : match[2]?.toLowerCase() === "k"
      ? 1_000
      : 1;
  const parsed = Number(match[1]) * multiplier;

  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export function cleanCandidateText(value) {
  return String(value || "")
    .replace(/\b(?:Read more|Show less|Verified Purchase|Helpful|Report)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDedupText(value) {
  return cleanCandidateText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isUsefulReviewText(text) {
  const normalized = cleanCandidateText(text);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  if (normalized.length < 20 || normalized.length > 1800 || wordCount < 4) {
    return false;
  }

  const lowerText = normalized.toLowerCase();
  const blockedTexts = [
    "customer reviews",
    "write a review",
    "sort by",
    "filter by",
    "back to top",
    "loading",
  ];

  return !blockedTexts.some((blockedText) => lowerText === blockedText);
}

export function extractRatingFromText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const outOfMatch = normalized.match(/(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*(5|10)\s*(?:stars?|rating)?/i);

  if (outOfMatch) {
    return {
      rating: Number(outOfMatch[1]),
      rating_max: Number(outOfMatch[2]),
    };
  }

  const compactStarMatch = normalized.match(new RegExp(`\\b([1-5](?:\\.\\d+)?)\\s*(?:stars?|star|rating|${STAR_PATTERN})(?:\\b|\\s|$)`, "i"));

  if (compactStarMatch) {
    return {
      rating: Number(compactStarMatch[1]),
      rating_max: 5,
    };
  }

  const starMatch = normalized.match(/(\d+(?:\.\d+)?)\s*stars?/i);

  if (starMatch) {
    return {
      rating: Number(starMatch[1]),
      rating_max: 5,
    };
  }

  const visibleStars = normalized.match(new RegExp(`[${STAR_PATTERN}]`, "g"));

  if (visibleStars?.length >= 1 && visibleStars.length <= 5) {
    return {
      rating: visibleStars.length,
      rating_max: 5,
    };
  }

  return {};
}

export function datePatterns() {
  return [
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
    /\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/i,
    /\b(?:today|yesterday|\d+\s+(?:day|week|month|year)s?\s+ago)\b/i,
    /\b(?:reviewed|posted|updated)\s+(?:on\s+)?[A-Z][a-z]{2,9}\s+\d{1,2},?\s+\d{4}\b/i,
  ];
}

export function extractTextCount(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      return parseCompactNumber(match[1]);
    }
  }

  return null;
}

export function firstString(...values) {
  for (const value of values.flat()) {
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value === "object") {
      const nested = firstString(value.name, value.text, value.value, value["@value"]);

      if (nested) {
        return nested;
      }

      continue;
    }

    const text = cleanCandidateText(value);

    if (text) {
      return text;
    }
  }

  return null;
}

export function joinUniqueText(parts) {
  const joinedParts = [];
  const seenParts = new Set();

  parts.filter(Boolean).forEach((part) => {
    const text = cleanCandidateText(part);
    const key = normalizeDedupText(text);

    if (!key || seenParts.has(key)) {
      return;
    }

    if (joinedParts.some((existingPart) => normalizeDedupText(existingPart).includes(key))) {
      return;
    }

    seenParts.add(key);
    joinedParts.push(text);
  });

  return joinedParts.join(". ");
}
