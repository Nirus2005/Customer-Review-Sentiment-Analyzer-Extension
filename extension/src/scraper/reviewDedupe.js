import {
  normalizeDedupText,
} from "./textUtils.js";

export function createSeenTracker() {
  return {
    keys: new Set(),
    texts: [],
  };
}

export function isDuplicateReview(text, seen) {
  const key = normalizeDedupText(text);

  if (!key || seen.keys.has(key)) {
    return true;
  }

  return seen.texts.some((existingText) => {
    const existingKey = normalizeDedupText(existingText);
    const shorter = existingKey.length < key.length ? existingKey : key;
    const longer = existingKey.length >= key.length ? existingKey : key;

    return shorter.length >= 80 && longer.includes(shorter) && shorter.length / longer.length >= 0.72;
  });
}

export function rememberReview(text, seen) {
  seen.keys.add(normalizeDedupText(text));
  seen.texts.push(text);
}
