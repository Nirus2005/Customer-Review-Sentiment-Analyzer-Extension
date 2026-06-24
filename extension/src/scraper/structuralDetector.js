import {
  combinedBounds,
  getDomDepth,
  isElementNode,
  isElementVisible,
  overlapRatio,
  queryAllWithSelf,
  safeRect,
} from "./domUtils.js";
import {
  cleanCandidateText,
  isUsefulReviewText,
} from "./textUtils.js";

export function detectRepeatedStructures(scope, {
  debugLog,
  reviewTextFromContainer,
  runtimeOptions,
}) {
  if (!scope) {
    return [];
  }

  const structuralCandidates = [];
  const parents = queryAllWithSelf(scope, "*")
    .filter((element) => element.children?.length >= 3)
    .slice(0, Number(runtimeOptions.maxStructuralParents) || 3500);

  parents.forEach((parent) => {
    const children = Array.from(parent.children).filter(isStructuralChildCandidate);

    if (children.length < 3) {
      return;
    }

    const groups = new Map();

    children.forEach((child) => {
      const signature = createStructuralSignature(child);
      const group = groups.get(signature) || [];

      group.push(child);
      groups.set(signature, group);
    });

    groups.forEach((group, signature) => {
      const usefulChildren = group.filter((child) => isUsefulReviewText(reviewTextFromContainer(child)));

      if (usefulChildren.length < 3) {
        return;
      }

      const stats = calculateStructureGroupStats(usefulChildren);

      if (usefulChildren.length < 5 && stats.stackedScore < 0.66) {
        return;
      }

      usefulChildren.forEach((element) => {
        structuralCandidates.push({
          element,
          group: {
            signature,
            siblingCount: group.length,
            substantialSiblingCount: usefulChildren.length,
            ...stats,
          },
        });
      });

      debugLog("Repeated structure group found.", {
        strategy: "structural",
        signature,
        siblingCount: group.length,
        substantialSiblingCount: usefulChildren.length,
        stackedScore: stats.stackedScore,
        similarSizeScore: stats.similarSizeScore,
      });
    });
  });

  return structuralCandidates
    .sort((left, right) => safeRect(left.element).top - safeRect(right.element).top);
}

function isStructuralChildCandidate(element) {
  if (!isElementNode(element)) {
    return false;
  }

  const tag = element.tagName.toLowerCase();

  if (["script", "style", "template", "noscript", "svg"].includes(tag)) {
    return false;
  }

  if (!isElementVisible(element)) {
    return false;
  }

  const rect = safeRect(element);

  if (rect.width < 160 || rect.height < 36) {
    return false;
  }

  return cleanCandidateText(element.innerText || element.textContent || "").length >= 35;
}

function createStructuralSignature(element) {
  const tag = element.tagName.toLowerCase();
  const visibleChildren = Array.from(element.children)
    .filter(isElementNode)
    .slice(0, 10)
    .map((child) => child.tagName.toLowerCase());
  const childSequence = visibleChildren.join(">");
  const childCount = element.children.length;
  const depth = Math.min(getDomDepth(element), 18);

  return `${tag}|${childCount}|${childSequence}|d${depth}`;
}

function calculateStructureGroupStats(elements) {
  const rects = elements.map(safeRect).filter((rect) => rect.width > 0 && rect.height > 0);

  if (rects.length < 2) {
    return {
      stackedScore: 0,
      similarSizeScore: 0,
      sectionAreaRatio: 0,
    };
  }

  const sortedRects = rects.slice().sort((left, right) => left.top - right.top);
  let stackedPairs = 0;
  let similarPairs = 0;

  for (let index = 1; index < sortedRects.length; index += 1) {
    const previous = sortedRects[index - 1];
    const current = sortedRects[index];
    const verticalGap = current.top - previous.bottom;
    const horizontalOverlap = overlapRatio(
      previous.left,
      previous.right,
      current.left,
      current.right,
    );
    const widthRatio = Math.min(previous.width, current.width) / Math.max(previous.width, current.width);
    const heightRatio = Math.min(previous.height, current.height) / Math.max(previous.height, current.height);

    if (current.top >= previous.top && verticalGap > -Math.min(previous.height, current.height) * 0.45 && horizontalOverlap >= 0.55) {
      stackedPairs += 1;
    }

    if (widthRatio >= 0.72 && heightRatio >= 0.45) {
      similarPairs += 1;
    }
  }

  const bounds = combinedBounds(rects);
  const viewportArea = Math.max(1, (window.innerWidth || 1) * (window.innerHeight || 1));

  return {
    stackedScore: stackedPairs / Math.max(1, sortedRects.length - 1),
    similarSizeScore: similarPairs / Math.max(1, sortedRects.length - 1),
    sectionAreaRatio: Math.min(1, (bounds.width * bounds.height) / viewportArea),
  };
}
