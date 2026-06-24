import {
  QUERY_SUBJECT_FILLER_TERMS,
  RETRIEVAL_STOP_WORDS,
} from "../constants/queryLexicon.js";
import {
  NEGATIVE_SIGNAL,
  POSITIVE_SIGNAL,
} from "./reviewProcessing.js";

const COMPLAINT_QUERY_SIGNAL = /\b(?:complaint|complaints|concern|concerns|dislike|dislikes|issue|issues|negative|problem|problems|risk|risks|bad|worst|wrong)\b/i;
const BALANCED_QUERY_SIGNAL = /\b(?:pros\s+and\s+cons|positive\s+and\s+negative|good\s+and\s+bad|strengths\s+and\s+weaknesses|advantages\s+and\s+disadvantages)\b/i;
const OVERALL_QUERY_SIGNAL = /\b(?:common\s+opinion|customer\s+opinion|customers?\s+think|general\s+opinion|general\s+sentiment|general\s+view|overall|opinion|sentiment|summary|summarize|verdict)\b/i;
const PRAISE_QUERY_SIGNAL = /\b(?:like|likes|love|positive|praise|pros|good|great|best)\b/i;
const COMPLAINT_ANSWER_SIGNAL = /\b(?:customers?\s+mainly\s+complain|complain|complaint|concern|concerns|dislike|issue|issues|problem|problems|defect|defective|fail|failed|failing|poor|bad|worse|worst|stopped|wore\s+out|uncomfortable)\b/i;
const ASSERTIVE_COMPLAINT_ANSWER_SIGNAL = /\b(?:customers?\s+(?:mainly|mostly|commonly)?\s*(?:complain|raise concerns|dislike)|main complaints?|major complaints?|common complaints?|issues?\s+include|problems?\s+include|concerns?\s+include|negative themes?\s+include)\b/i;
const PRAISE_ANSWER_SIGNAL = /\b(?:customers?\s+(?:mostly\s+)?praise|mostly\s+positive|generally\s+positive|love|like|recommend|excellent|great|top[-\s]?notch|premium)\b/i;
const ASSERTIVE_PRAISE_ANSWER_SIGNAL = /\b(?:customers?\s+(?:mostly|mainly|commonly)?\s*(?:praise|like|love|recommend)|main positives?|major positives?|positive themes?\s+include|pros?\s+include)\b/i;
const NO_EVIDENCE_ANSWER_SIGNAL = /\b(?:could not|couldn't|did not|didn't|do not|don't|no|not enough|nothing)\b.{0,90}\b(?:complaint|complaints|concern|concerns|issue|issues|problem|problems|negative|positive|praise|evidence|relevant)\b/i;

const POSITIVE_DESCRIPTORS = [
  ["premium", "premium"],
  ["top-notch", "top-notch"],
  ["top notch", "top-notch"],
  ["top quality", "top quality"],
  ["high quality", "high quality"],
  ["good quality", "good quality"],
  ["great quality", "great quality"],
  ["sturdy", "sturdy"],
  ["durable", "durable"],
];

const NEGATIVE_DESCRIPTORS = [
  ["poor quality", "poor quality"],
  ["cheap", "cheap-feeling"],
  ["heel is higher", "heel height"],
  ["higher than", "heel height"],
  ["run a bit small", "sizing"],
  ["runs a bit small", "sizing"],
  ["small", "sizing"],
  ["tight", "fit"],
  ["uncomfortable", "uncomfortable"],
  ["stiff", "stiff"],
  ["wore out", "wearing out quickly"],
  ["broke", "breaking"],
  ["broken", "broken"],
  ["cracked", "cracking"],
  ["not durable", "not durable"],
  ["not comfortable", "not comfortable"],
];

const SUMMARY_STYLE_TERMS = new Set([
  "advantage",
  "advantages",
  "bad",
  "con",
  "cons",
  "disadvantage",
  "disadvantages",
  "good",
  "negative",
  "positive",
  "pro",
  "pros",
  "summarize",
  "summary",
]);

export function inferFallbackIntent(query) {
  const lowerQuery = String(query || "").toLowerCase();

  if (BALANCED_QUERY_SIGNAL.test(lowerQuery)) {
    return "balanced";
  }

  if (PRAISE_QUERY_SIGNAL.test(lowerQuery)) {
    return "positive";
  }

  if (OVERALL_QUERY_SIGNAL.test(lowerQuery)) {
    return "overall";
  }

  if (COMPLAINT_QUERY_SIGNAL.test(lowerQuery)) {
    return "complaint";
  }

  return "neutral";
}

export function buildBalancedFallbackAnswer(query, chunks) {
  const queryTerms = meaningfulQueryTerms(query);
  const subjectTerms = queryTerms.filter((term) => !SUMMARY_STYLE_TERMS.has(term));
  const focusedChunks = focusChunksByQuery(chunks, subjectTerms);
  const praiseChunks = focusedChunks.filter(isPraiseEvidenceChunk);
  const complaintChunks = focusedChunks.filter(isComplaintEvidenceChunk);
  const praiseDescriptors = evidenceDescriptors(praiseChunks, subjectTerms, {
    positiveRatio: 1,
    negativeRatio: 0,
  });
  const complaintDescriptors = evidenceDescriptors(complaintChunks, subjectTerms, {
    positiveRatio: 0,
    negativeRatio: 1,
  });
  const pros = praiseDescriptors.length
    ? joinHumanList(praiseDescriptors)
    : praiseChunks.length
      ? "generally positive experiences"
      : "";
  const cons = complaintDescriptors.length
    ? joinHumanList(complaintDescriptors)
    : complaintChunks.length
      ? "some negative or mixed experiences"
      : "";

  if (!focusedChunks.length) {
    return "I could not find anything relevant to that in the analyzed reviews/comments.";
  }

  if (pros && cons) {
    return `Pros: customers praise ${pros}. Cons: customers raise concerns about ${cons}.`;
  }

  if (pros) {
    return `Pros: customers praise ${pros}. Cons: I did not find clear complaint evidence in the retrieved reviews/comments.`;
  }

  if (cons) {
    return `Pros: I did not find clear praise evidence in the retrieved reviews/comments. Cons: customers raise concerns about ${cons}.`;
  }

  return "The retrieved reviews do not provide enough clear positive or negative evidence for a pros and cons summary.";
}

export function buildAspectFallbackAnswer(query, chunks) {
  const queryTerms = meaningfulQueryTerms(query);
  const subject = querySubject(queryTerms);
  const focusedChunks = focusChunksByQuery(chunks, queryTerms);
  const evidence = evidenceSentiment(focusedChunks);
  const descriptors = evidenceDescriptors(focusedChunks, queryTerms, evidence);
  const descriptorText = descriptors.length
    ? `, especially ${joinHumanList(descriptors)}`
    : "";

  if (!focusedChunks.length) {
    return "I could not find anything relevant to that in the analyzed reviews/comments.";
  }

  if (evidence.positiveRatio >= 0.6 && evidence.negativeRatio < 0.3) {
    return `Customers are positive about ${subject}${descriptorText}.`;
  }

  if (evidence.negativeRatio >= 0.5 && evidence.positiveRatio < 0.35) {
    return `Customers raise concerns about ${subject}${descriptorText}.`;
  }

  if (evidence.mixedRatio >= 0.35 || (evidence.positive > 0 && evidence.negative > 0)) {
    return `Feedback on ${subject} is mixed${descriptorText}.`;
  }

  return `The retrieved reviews mention ${subject}, but there is not enough consistent evidence for a stronger summary.`;
}

export function buildOverallFallbackAnswer(query, chunks) {
  const queryTerms = meaningfulQueryTerms(query);
  const subject = querySubject(queryTerms);
  const focusedChunks = focusChunksByQuery(chunks, queryTerms);
  const evidence = evidenceSentiment(focusedChunks);
  const mixedThemes = evidenceDescriptors(focusedChunks, queryTerms, {
    ...evidence,
    negativeRatio: evidence.negativeRatio + evidence.mixedRatio,
  });
  const themeText = mixedThemes.length
    ? `, with some mixed feedback about ${joinHumanList(mixedThemes)}`
    : evidence.mixedRatio >= 0.35
      ? ", with some mixed feedback"
    : "";

  if (!focusedChunks.length) {
    return "I could not find anything relevant to that in the analyzed reviews/comments.";
  }

  if (evidence.positiveRatio >= 0.45 && evidence.negativeRatio < 0.25) {
    return `Overall, customers are mostly positive about ${subject}${themeText}.`;
  }

  if (evidence.negativeRatio >= 0.45 && evidence.positiveRatio < 0.35) {
    return `Overall, customers are mostly negative about ${subject}${themeText}.`;
  }

  if (evidence.mixedRatio >= 0.35 || (evidence.positive > 0 && evidence.negative > 0)) {
    return `Overall opinion about ${subject} is mixed${themeText}.`;
  }

  return `The retrieved reviews mention ${subject}, but there is not enough consistent evidence for a stronger overall summary.`;
}

export function answerContradictsEvidence(answer, chunks, analysis) {
  if (!answer || !Array.isArray(chunks) || !chunks.length) {
    return false;
  }

  const evidence = evidenceSentiment(chunks);

  if (evidence.total < 2) {
    return false;
  }

  const answerText = String(answer || "");
  const asksForComplaint = analysis?.querySentiment === "negative" || analysis?.queryIntent === "negative";
  const asksForPraise = analysis?.querySentiment === "positive" || analysis?.queryIntent === "positive";
  const positiveHeavy = evidence.positiveRatio >= 0.75 && evidence.negativeRatio <= 0.2;
  const negativeHeavy = evidence.negativeRatio >= 0.65 && evidence.positiveRatio <= 0.25;
  const noEvidenceAnswer = NO_EVIDENCE_ANSWER_SIGNAL.test(answerText);

  if (!asksForComplaint && positiveHeavy && COMPLAINT_ANSWER_SIGNAL.test(answerText) && !noEvidenceAnswer) {
    return true;
  }

  if (asksForComplaint && positiveHeavy && ASSERTIVE_COMPLAINT_ANSWER_SIGNAL.test(answerText) && !noEvidenceAnswer) {
    return true;
  }

  if (!asksForPraise && negativeHeavy && PRAISE_ANSWER_SIGNAL.test(answerText) && !noEvidenceAnswer) {
    return true;
  }

  if (asksForPraise && negativeHeavy && ASSERTIVE_PRAISE_ANSWER_SIGNAL.test(answerText) && !noEvidenceAnswer) {
    return true;
  }

  return false;
}

function focusChunksByQuery(chunks, queryTerms) {
  if (!queryTerms.length) {
    return chunks;
  }

  const focusedChunks = chunks.filter((chunk) => {
    const text = String(chunk.text || "").toLowerCase();
    return queryTerms.some((term) => text.includes(term));
  });

  return focusedChunks.length ? focusedChunks : chunks;
}

function evidenceSentiment(chunks) {
  const counts = {
    positive: 0,
    negative: 0,
    mixed: 0,
  };

  chunks.forEach((chunk) => {
    const text = String(chunk.text || "");
    const label = String(chunk.metadata?.sentiment_label || "").toLowerCase();

    if (label === "positive" || (!label && POSITIVE_SIGNAL.test(text) && !NEGATIVE_SIGNAL.test(text))) {
      counts.positive += 1;
    } else if (label === "negative" || (!label && NEGATIVE_SIGNAL.test(text) && !POSITIVE_SIGNAL.test(text))) {
      counts.negative += 1;
    } else {
      counts.mixed += 1;
    }
  });

  const total = counts.positive + counts.negative + counts.mixed;

  return {
    ...counts,
    total,
    positiveRatio: total ? counts.positive / total : 0,
    negativeRatio: total ? counts.negative / total : 0,
    mixedRatio: total ? counts.mixed / total : 0,
  };
}

function evidenceDescriptors(chunks, queryTerms, evidence) {
  const descriptorMap = new Map();
  const descriptors = evidence.negativeRatio > evidence.positiveRatio
    ? NEGATIVE_DESCRIPTORS
    : POSITIVE_DESCRIPTORS;

  chunks.forEach((chunk) => {
    const lowerText = String(chunk.text || "").toLowerCase();

    if (queryTerms.length && !queryTerms.some((term) => lowerText.includes(term))) {
      return;
    }

    descriptors.forEach(([needle, label]) => {
      if (lowerText.includes(needle)) {
        descriptorMap.set(label, (descriptorMap.get(label) || 0) + 1);
      }
    });
  });

  return Array.from(descriptorMap.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([label]) => label);
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

function querySubject(queryTerms) {
  return queryTerms.length ? queryTerms.slice(0, 3).join(" ") : "that";
}

function meaningfulQueryTerms(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !RETRIEVAL_STOP_WORDS.has(term))
    .filter((term) => !QUERY_SUBJECT_FILLER_TERMS.has(term))
    .filter((term) => !["does", "what", "which", "would", "could", "should"].includes(term));
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
