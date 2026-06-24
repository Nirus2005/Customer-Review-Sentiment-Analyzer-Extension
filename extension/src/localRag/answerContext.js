import { RAG_LIMITS } from "../constants/ragConfig.js";
import { ASPECT_PATTERNS } from "./reviewProcessing.js";
import {
  buildAspectFallbackAnswer,
  buildBalancedFallbackAnswer,
  buildOverallFallbackAnswer,
  inferFallbackIntent,
} from "./evidenceSummary.js";
import {
  NEGATIVE_SIGNAL,
  POSITIVE_SIGNAL,
} from "./reviewProcessing.js";

export { answerContradictsEvidence } from "./evidenceSummary.js";

export function formatContextForPrompt(chunks, maxContextTokens) {
  const blocks = [];
  const contextChunks = [];
  let usedTokens = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const block = formatChunkBlock(chunk, blocks.length + 1);
    const tokenCount = estimateTokens(block);

    if (usedTokens + tokenCount > maxContextTokens) {
      break;
    }

    blocks.push(block);
    contextChunks.push(chunk);
    usedTokens += tokenCount;
  }

  return {
    context: blocks.length ? blocks.join("\n\n") : "No review context available.",
    contextChunks,
    usedTokens,
  };
}

export function formatRecentChat(messages, maxMessages = RAG_LIMITS.maxRecentMessages) {
  const recentMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role && message?.content)
    .slice(-maxMessages);

  if (!recentMessages.length) {
    return "No previous chat history.";
  }

  const lines = recentMessages.map((message) => {
    const role = String(message.role).toLowerCase() === "assistant" ? "Assistant" : "User";
    return `${role}: ${String(message.content).trim()}`;
  });

  return lines.join("\n") || "No previous chat history.";
}

export function buildAnalyticsText(session, analysis) {
  const metrics = session.metrics || {};
  const lines = [];
  const pageTitle = String(session.pageTitle || "").trim();
  const pageUrl = String(session.pageUrl || "").trim();

  if (pageTitle) {
    lines.push(`Page title: ${pageTitle.slice(0, 160)}`);
  } else if (pageUrl) {
    lines.push(`Page URL: ${pageUrl.slice(0, 160)}`);
  }

  const totalReviews = metrics.total_reviews ?? session.reviewCount ?? 0;

  if (totalReviews) {
    const indexedReviews = Number(session.indexedReviewCount ?? totalReviews) || 0;
    const queuedReviews = Number(session.backlogReviewCount ?? 0) || 0;
    const unqueuedReviews = Number(session.unqueuedReviewCount ?? 0) || 0;

    if (session.progressiveIndex && indexedReviews < totalReviews) {
      lines.push(
        `Analyzed evidence: ${indexedReviews} of ${totalReviews} reviews/comments; ` +
        `${queuedReviews} queued for query-time analysis` +
        `${unqueuedReviews ? `; ${unqueuedReviews} skipped by local storage cap` : ""}.`,
      );
    } else {
      lines.push(`Analyzed reviews/comments: ${totalReviews}`);
    }
  }

  if (analysis?.querySentiment === "negative") {
    lines.push(`Relevant distribution: negative ${countPct(metrics, "negative")}; mixed ${countPct(metrics, "mixed")}`);
  } else if (analysis?.querySentiment === "positive") {
    lines.push(`Relevant distribution: positive ${countPct(metrics, "positive")}; mixed ${countPct(metrics, "mixed")}`);
  } else {
    lines.push(
      `Sentiment distribution: positive ${countPct(metrics, "positive")}; ` +
      `negative ${countPct(metrics, "negative")}; mixed ${countPct(metrics, "mixed")}`,
    );
  }

  if (metrics.average_confidence !== null && metrics.average_confidence !== undefined) {
    lines.push(`Average sentiment confidence: ${Number(metrics.average_confidence).toFixed(2)}`);
  }

  if (Number.isFinite(Number(metrics.average_rating))) {
    lines.push(`Average rating: ${Number(metrics.average_rating).toFixed(1)} out of 5 from ${metrics.rated_reviews} rated reviews`);
  }

  return lines.join("\n") || "No session analytics available.";
}

export function buildFallbackAnswer(query, chunks, session) {
  const intent = inferFallbackIntent(query);
  const metrics = session?.metrics || {};

  if (!chunks.length) {
    return "I could not find enough relevant review evidence in the local index to answer that.";
  }

  if (intent === "overall") {
    return hasSpecificSubject(query)
      ? buildOverallFallbackAnswer(query, chunks)
      : buildSessionSentimentAnswer(metrics, session);
  }

  if (intent === "balanced") {
    return buildBalancedFallbackAnswer(query, chunks);
  }

  if (intent === "neutral") {
    return buildAspectFallbackAnswer(query, chunks);
  }

  if (intent === "positive") {
    const praiseChunks = chunks.filter(isPraiseEvidenceChunk);
    const aspectLabels = topAspects(praiseChunks, "positive");

    return aspectLabels.length
      ? `Customers mostly praise ${joinHumanList(aspectLabels)}.`
      : "Customers are generally positive, but the retrieved comments do not cluster around one clear praise theme.";
  }

  const complaintChunks = chunks.filter(isComplaintEvidenceChunk);
  const aspectLabels = topAspects(complaintChunks, "negative");

  if (!complaintChunks.length) {
    return "I did not find complaint evidence in the retrieved reviews/comments.";
  }

  return aspectLabels.length
    ? `Customers mainly complain about ${joinHumanList(aspectLabels)}.`
    : "The negative or mixed reviews are varied, so there is no single dominant complaint theme in the retrieved evidence.";
}

function buildSessionSentimentAnswer(metrics, session) {
  const total = metrics.total_reviews ?? session?.reviewCount ?? 0;
  return `Overall sentiment is ${dominantSentiment(metrics)} across ${total} analyzed reviews, with ${roundPct(metrics.positive_pct)} positive, ${roundPct(metrics.negative_pct)} negative, and ${roundPct(metrics.mixed_pct)} mixed.`;
}

function formatChunkBlock(chunk, index) {
  const metadata = chunk.metadata || {};
  const labelParts = [`Review ${index}`];

  if (metadata.rating !== null && metadata.rating !== undefined) {
    labelParts.push(
      metadata.rating_max !== null && metadata.rating_max !== undefined
        ? `rating: ${metadata.rating}/${metadata.rating_max}`
        : `rating: ${metadata.rating}`,
    );
  }

  if (metadata.date) {
    labelParts.push(`date: ${metadata.date}`);
  }

  if (metadata.upvotes !== null && metadata.upvotes !== undefined) {
    labelParts.push(`upvotes: ${metadata.upvotes}`);
  }

  if (metadata.downvotes !== null && metadata.downvotes !== undefined) {
    labelParts.push(`downvotes: ${metadata.downvotes}`);
  }

  if (metadata.helpfulness) {
    labelParts.push(`helpfulness: ${metadata.helpfulness}`);
  } else if (metadata.helpful_votes !== null && metadata.helpful_votes !== undefined) {
    labelParts.push(`helpful votes: ${metadata.helpful_votes}`);
  }

  return `[${labelParts.join(" | ")}]\n${String(chunk.text || "").trim()}`;
}

function topAspects(chunks, tone = "neutral") {
  return ASPECT_PATTERNS
    .map((aspect) => {
      const score = chunks.reduce((sum, chunk) => {
        const text = ` ${String(chunk.text || "").toLowerCase()} `;
        const matches = aspect.terms.filter((term) => text.includes(term)).length;
        return sum + matches;
      }, 0);

      return { label: aspect.label, score };
    })
    .filter((aspect) => aspect.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((aspect) => aspectLabelForTone(aspect.label, tone));
}

function aspectLabelForTone(label, tone) {
  if (tone !== "positive") {
    return label;
  }

  switch (label) {
    case "lights or product features failing":
      return "lights or product features";
    case "color or appearance":
      return "style or appearance";
    default:
      return label;
  }
}

function isComplaintEvidenceChunk(chunk) {
  const text = String(chunk.text || "");
  const label = String(chunk.metadata?.sentiment_label || "").toLowerCase();

  if (label === "negative") {
    return true;
  }

  if (label === "mixed") {
    return NEGATIVE_SIGNAL.test(text);
  }

  return !label && NEGATIVE_SIGNAL.test(text) && !POSITIVE_SIGNAL.test(text);
}

function isPraiseEvidenceChunk(chunk) {
  const text = String(chunk.text || "");
  const label = String(chunk.metadata?.sentiment_label || "").toLowerCase();

  if (label === "positive") {
    return true;
  }

  if (label === "mixed") {
    return POSITIVE_SIGNAL.test(text);
  }

  return !label && POSITIVE_SIGNAL.test(text) && !NEGATIVE_SIGNAL.test(text);
}

function hasSpecificSubject(query) {
  const normalized = String(query || "").toLowerCase();
  return /\b(?:about|regarding|toward|towards|for)\s+(?:the\s+)?[a-z0-9-]{3,}/i.test(normalized);
}

function countPct(metrics, key) {
  const count = Number(metrics[key] || 0);
  const pct = Number(metrics[`${key}_pct`] || 0);
  return `${Math.round(count)} (${pct.toFixed(1)}%)`;
}

function dominantSentiment(metrics) {
  const options = [
    ["positive", Number(metrics.positive) || 0],
    ["negative", Number(metrics.negative) || 0],
    ["mixed", Number(metrics.mixed) || 0],
  ].sort((left, right) => right[1] - left[1]);

  return options[0]?.[0] || "mixed";
}

function joinHumanList(items) {
  if (items.length <= 1) {
    return items[0] || "";
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function roundPct(value) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return "0%";
  }

  const rounded = Math.round(numericValue * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

function estimateTokens(text) {
  const cleanText = String(text || "").trim();

  if (!cleanText) {
    return 0;
  }

  const wordEstimate = cleanText.split(/\s+/).length * 1.25;
  const charEstimate = cleanText.length / 4;
  return Math.ceil(Math.max(wordEstimate, charEstimate));
}
