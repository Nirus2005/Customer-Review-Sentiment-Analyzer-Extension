export const POSITIVE_SIGNAL = /\b(?:amazing|beautiful|best|comfortable|excellent|fun|good|great|happy|like|liked|love|loved|nice|perfect|recommend|works|worth)\b/i;
export const NEGATIVE_SIGNAL = /\b(?:bad|broke|broken|cheap|complain|complaint|defect|defective|disappoint|disappointed|doesn't|dont|don't|dull|expensive|failed|hard|issue|missing|not|poor|problem|return|small|stopped|tight|uncomfortable|wrong)\b/i;
const CONTRAST_SIGNAL = /\b(?:although|but|except|however|though|while|yet)\b/i;
const CHUNK_WORD_LIMIT = 180;
const CHUNK_OVERLAP = 30;

export const ASPECT_PATTERNS = [
  {
    label: "lights or product features failing",
    terms: ["light", "lights", "lighting", "lit", "battery", "working", "work"],
  },
  {
    label: "comfort and fit",
    terms: ["comfortable", "uncomfortable", "comfort", "fit", "fits", "tight", "wear"],
  },
  {
    label: "sizing accuracy",
    terms: ["size", "sizing", "small", "large", "big", "narrow", "wide"],
  },
  {
    label: "quality or durability",
    terms: ["quality", "durable", "durability", "broke", "broken", "worn", "wear", "stopped"],
  },
  {
    label: "delivery or packaging",
    terms: ["arrived", "delivery", "package", "packaging", "shipping", "late", "damaged"],
  },
  {
    label: "price and value",
    terms: ["price", "expensive", "cheap", "cost", "value", "worth"],
  },
  {
    label: "color or appearance",
    terms: ["beautiful", "color", "colors", "dull", "look", "looks", "style"],
  },
];

export function normalizeReviewSentiment(result, text) {
  const score = Number(result?.score ?? 0);
  const rawLabel = String(result?.label || "").toLowerCase();
  const hasPositiveSignal = POSITIVE_SIGNAL.test(text);
  const hasNegativeSignal = NEGATIVE_SIGNAL.test(text);
  const looksMixed = (
    score < 0.72 ||
    (CONTRAST_SIGNAL.test(text) && hasPositiveSignal && hasNegativeSignal)
  );

  if (looksMixed) {
    return {
      label: "mixed",
      score,
    };
  }

  if (rawLabel.includes("neg")) {
    return {
      label: "negative",
      score,
    };
  }

  return {
    label: "positive",
    score,
  };
}

export function buildSessionMetrics(reviews) {
  const sentimentCounts = {
    positive: 0,
    negative: 0,
    mixed: 0,
  };
  let confidenceTotal = 0;
  let confidenceCount = 0;
  let ratingTotal = 0;
  let ratingCount = 0;

  reviews.forEach((review) => {
    const label = ["positive", "negative", "mixed"].includes(review.sentiment_label)
      ? review.sentiment_label
      : "mixed";

    sentimentCounts[label] += 1;

    if (Number.isFinite(Number(review.sentiment_score))) {
      confidenceTotal += Number(review.sentiment_score);
      confidenceCount += 1;
    }

    if (Number.isFinite(Number(review.rating))) {
      const ratingMax = Number(review.rating_max) || 5;
      ratingTotal += (Number(review.rating) / ratingMax) * 5;
      ratingCount += 1;
    }
  });

  const totalReviews = reviews.length;
  const pct = (count) => (totalReviews ? (count / totalReviews) * 100 : 0);

  return {
    total_reviews: totalReviews,
    positive: sentimentCounts.positive,
    negative: sentimentCounts.negative,
    mixed: sentimentCounts.mixed,
    positive_pct: pct(sentimentCounts.positive),
    negative_pct: pct(sentimentCounts.negative),
    mixed_pct: pct(sentimentCounts.mixed),
    average_confidence: confidenceCount ? confidenceTotal / confidenceCount : null,
    average_rating: ratingCount ? ratingTotal / ratingCount : null,
    rated_reviews: ratingCount,
  };
}

export function createReviewChunks(reviews, sessionId) {
  const chunks = [];

  reviews.forEach((review, reviewIndex) => {
    const cleanText = normalizeWhitespace(review.text);

    if (!cleanText) {
      return;
    }

    // A simple sentence splitter by punctuation
    const sentences = cleanText.split(/(?<=[.?!])\s+/).filter(Boolean);
    const reviewId = review.id || `${sessionId}-review-${reviewIndex + 1}`;
    const metadata = {
      source_id: review.source_id ?? null,
      review_index: Number.isInteger(review.original_index) ? review.original_index : reviewIndex,
      sentiment_label: review.sentiment_label || "mixed",
      sentiment_score: review.sentiment_score ?? null,
      rating: review.rating ?? null,
      rating_max: review.rating_max ?? null,
      upvotes: review.upvotes ?? null,
      upvote_count: review.upvote_count ?? null,
      likes: review.likes ?? null,
      like_count: review.like_count ?? null,
      downvotes: review.downvotes ?? null,
      downvote_count: review.downvote_count ?? null,
      dislikes: review.dislikes ?? null,
      dislike_count: review.dislike_count ?? null,
      helpful_votes: review.helpful_votes ?? null,
      helpful_count: review.helpful_count ?? null,
      helpfulness_count: review.helpfulness_count ?? null,
      helpfulness: review.helpfulness ?? null,
      date: review.date ?? null,
    };

    let currentChunkSentences = [];
    let currentWordCount = 0;
    let chunkIndex = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const wordCount = sentence.split(/\s+/).filter(Boolean).length;

      if (currentWordCount + wordCount > CHUNK_WORD_LIMIT && currentChunkSentences.length > 0) {
        // Push the current chunk
        chunks.push({
          id: `${reviewId}-chunk-${chunkIndex + 1}`,
          sessionId,
          reviewId,
          chunkIndex,
          text: currentChunkSentences.join(" "),
          metadata,
        });
        chunkIndex += 1;
        // Keep the last sentence as overlap
        const lastSentence = currentChunkSentences[currentChunkSentences.length - 1];
        currentChunkSentences = [lastSentence, sentence];
        currentWordCount = lastSentence.split(/\s+/).filter(Boolean).length + wordCount;
      } else {
        currentChunkSentences.push(sentence);
        currentWordCount += wordCount;
      }
    }

    if (currentChunkSentences.length > 0) {
      chunks.push({
        id: `${reviewId}-chunk-${chunkIndex + 1}`,
        sessionId,
        reviewId,
        chunkIndex,
        text: currentChunkSentences.join(" "),
        metadata,
      });
    }
  });

  return chunks;
}

export function attachEmbeddingsToChunks(chunks, embeddings) {
  return chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index] || [],
  }));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
