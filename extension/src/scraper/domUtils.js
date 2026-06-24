import {
  cleanCandidateText,
} from "./textUtils.js";

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

export function resolveScrapeRoot(runtimeOptions, selectionOnly) {
  if (runtimeOptions.rootSelector && typeof document !== "undefined") {
    const selectedRoot = document.querySelector(runtimeOptions.rootSelector);

    if (selectedRoot) {
      return selectedRoot;
    }
  }

  if (selectionOnly) {
    return resolveSelectionRoot();
  }

  return typeof document !== "undefined" ? document : null;
}

function resolveSelectionRoot() {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") {
    return null;
  }

  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0 || !cleanCandidateText(selection.toString())) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const element = commonAncestor.nodeType === ELEMENT_NODE
    ? commonAncestor
    : commonAncestor.parentElement;

  return nearestMeaningfulParent(element, cleanCandidateText(selection.toString()));
}

function nearestMeaningfulParent(element, selectedText) {
  const blockTags = new Set([
    "article",
    "section",
    "main",
    "div",
    "li",
    "ul",
    "ol",
    "table",
    "tbody",
    "tr",
    "ytd-comment-thread-renderer",
  ]);
  let current = element;
  let fallback = element;

  for (let depth = 0; current && current !== document.documentElement && depth < 8; depth += 1) {
    if (current.nodeType !== ELEMENT_NODE) {
      current = current.parentElement;
      continue;
    }

    const tag = current.tagName.toLowerCase();
    const text = cleanCandidateText(current.innerText || current.textContent || "");
    const rect = safeRect(current);
    const hasEnoughText = text.length >= Math.min(Math.max(selectedText.length, 40), 180);
    const hasUsableShape = rect.width >= 140 && rect.height >= 40;

    fallback = current;

    if (blockTags.has(tag) && hasEnoughText && hasUsableShape) {
      return current;
    }

    current = current.parentElement;
  }

  return fallback || (typeof document !== "undefined" ? document.body : null);
}

export function queryAllWithin(scope, selector) {
  if (!scope || !selector) {
    return [];
  }

  try {
    return Array.from(scope.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function queryAllWithSelf(scope, selector) {
  const matches = queryAllWithin(scope, selector);

  if (scope?.nodeType === ELEMENT_NODE) {
    try {
      if (scope.matches(selector)) {
        matches.unshift(scope);
      }
    } catch {
      return matches;
    }
  }

  return matches;
}

export function isElementVisible(element) {
  const rect = safeRect(element);

  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  if (typeof getComputedStyle !== "function") {
    return true;
  }

  const style = getComputedStyle(element);

  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0.05;
}

export function safeRect(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") {
    return emptyRect();
  }

  const rect = element.getBoundingClientRect() || {};

  return {
    top: Number(rect.top) || 0,
    right: Number(rect.right) || 0,
    bottom: Number(rect.bottom) || 0,
    left: Number(rect.left) || 0,
    width: Number(rect.width) || 0,
    height: Number(rect.height) || 0,
  };
}

export function getDomDepth(element) {
  let depth = 0;
  let current = element;

  while (current?.parentElement) {
    depth += 1;
    current = current.parentElement;
  }

  return depth;
}

export function overlapRatio(leftA, rightA, leftB, rightB) {
  const overlap = Math.max(0, Math.min(rightA, rightB) - Math.max(leftA, leftB));
  const minWidth = Math.max(1, Math.min(rightA - leftA, rightB - leftB));

  return overlap / minWidth;
}

export function combinedBounds(rects) {
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  return {
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function isElementNode(node) {
  return node?.nodeType === ELEMENT_NODE;
}

export function isDocumentNode(node) {
  return node?.nodeType === DOCUMENT_NODE;
}

function emptyRect() {
  return {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: 0,
    height: 0,
  };
}
