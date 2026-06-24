const FALLBACK_ANSWER = "I could not find anything relevant to that in the analyzed reviews/comments.";
const UNSAFE_SCRIPT_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

export function cleanAssistantAnswer(answer, userQuestion = "") {
  if (!answer) {
    return FALLBACK_ANSWER;
  }

  let cleaned = String(answer).trim();

  if (isObjectString(cleaned) || isDegenerateGeneratedText(cleaned)) {
    return FALLBACK_ANSWER;
  }

  cleaned = stripModelWrapperTags(cleaned);
  cleaned = removeUnsafeScriptArtifacts(cleaned);

  const badMarkers = [
    "<conversation_summary>",
    "</conversation_summary>",
    "<recent_chat>",
    "</recent_chat>",
    "<reviews>",
    "</reviews>",
    "<session_analytics>",
    "</session_analytics>",
    "<answer_style>",
    "</answer_style>",
    "<user_question>",
    "</user_question>",
    "<previous_chat>",
    "</previous_chat>",
  ];

  for (const marker of badMarkers) {
    if (cleaned.includes(marker)) {
      cleaned = cleaned.split(marker)[0].trim();
    }
  }

  cleaned = removeLeadingPromptEcho(cleaned);
  cleaned = stripLeadingAnswerLabels(cleaned);
  cleaned = removeMarkdownEmphasis(cleaned);
  cleaned = removeForbiddenOpeners(cleaned);
  cleaned = removeMetaCommentary(cleaned);
  cleaned = removeForbiddenSections(cleaned);
  cleaned = removeMarkdownEmphasis(cleaned);
  cleaned = removeUnsafeScriptArtifacts(cleaned);

  if (!cleaned || hasUnsafeScriptArtifact(cleaned) || isQuestionEcho(cleaned, userQuestion)) {
    return FALLBACK_ANSWER;
  }

  return cleaned;
}

export function cleanStreamingAnswer(answer) {
  let cleaned = stripModelWrapperTags(answer);
  cleaned = removeUnsafeScriptArtifacts(cleaned);
  cleaned = removeLeadingPromptEcho(cleaned);
  cleaned = stripLeadingAnswerLabels(cleaned);
  cleaned = removeMarkdownEmphasis(cleaned);
  cleaned = removeForbiddenOpeners(cleaned);
  cleaned = removeMetaCommentary(cleaned);
  cleaned = removeForbiddenSections(cleaned);
  cleaned = removeMarkdownEmphasis(cleaned);

  if (
    !cleaned ||
    isObjectString(cleaned) ||
    isDegenerateGeneratedText(cleaned) ||
    hasUnsafeScriptArtifact(cleaned)
  ) {
    return "";
  }

  return cleaned;
}

export function isUnsafeGeneratedAnswer({ rawAnswer, cleanedAnswer, userQuestion }) {
  const combined = `${rawAnswer || ""}\n${cleanedAnswer || ""}`.toLowerCase();
  const querySentiment = detectQuestionSentiment(userQuestion);
  const unsafePatterns = [
    /\[object\s+Object\]/i,
    /<\/?(?:response|text|assistant|message|content)\b/i,
    /\bthe\s+user\s+is\s+asking\b/i,
    /\bhere'?s\s+a\s+response\b/i,
    /^\s*recommendations?\s*:/im,
    /^\s*(?:complaint|dislike)\s*:\s*$/im,
    /\bconsider\s+(?:upgrading|buying|purchasing|trying)\b/i,
    /\bfrom\s+a\s+brand\s+that\b/i,
    /\bnot\s+sure\s+if\s+i'?d\s+want\s+to\s+buy\b/i,
  ];

  if (
    unsafePatterns.some((pattern) => pattern.test(combined)) ||
    isDegenerateGeneratedText(rawAnswer) ||
    isDegenerateGeneratedText(cleanedAnswer)
  ) {
    return true;
  }

  if (
    ["negative", "positive"].includes(querySentiment) &&
    /^\s*(?:\d+\.\s+|[-*]\s+(?:positive|negative|mixed)\s*:)/im.test(cleanedAnswer || "")
  ) {
    return true;
  }

  return false;
}

export function isDegenerateGeneratedText(answer) {
  const compact = String(answer || "").replace(/\s+/g, "");

  if (compact.length < 32) {
    return false;
  }

  if (/(.)\1{10,}/u.test(compact)) {
    return true;
  }

  if (/(.{2,6})\1{5,}/u.test(compact)) {
    return true;
  }

  const uniqueChars = new Set(Array.from(compact)).size;
  return compact.length >= 80 && uniqueChars / compact.length < 0.12;
}

function isObjectString(answer) {
  return /^\s*(?:\[object\s+Object\]\s*,?\s*)+$/i.test(String(answer || ""));
}

export function hasPromptEcho(answer, userQuestion) {
  const firstLine = String(answer || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";

  if (/^(?:user\s*question|question)\s*:/i.test(firstLine)) {
    return true;
  }

  return isQuestionEcho(stripLeadingAnswerLabels(answer), userQuestion);
}

function stripModelWrapperTags(answer) {
  return String(answer || "")
    .replace(/<\/?(?:response|text|answer|assistant|message|content)[^>]*>/gi, "")
    .replace(/```(?:xml|json|text)?\s*|\s*```/gi, "")
    .trim();
}

function removeLeadingPromptEcho(answer) {
  const lines = String(answer || "").split(/\r?\n/);

  while (lines.length) {
    const firstLine = lines[0].trim();

    if (!firstLine) {
      lines.shift();
      continue;
    }

    if (!/^(?:user\s*question|question)\s*:/i.test(firstLine)) {
      break;
    }

    const inlineAnswer = firstLine.split(/\b(?:answer|assistant|response)\s*:\s*/i);

    if (inlineAnswer.length > 1 && inlineAnswer[1].trim()) {
      lines[0] = inlineAnswer[1].trim();
      break;
    }

    lines.shift();
  }

  return lines.join("\n").trim();
}

function stripLeadingAnswerLabels(answer) {
  let cleaned = String(answer || "").trim();
  const labelPattern = /^\s*(?:final\s+answer|answer|assistant|response|users?'?\s+responses?)\s*:\s*/i;

  for (let index = 0; index < 3; index += 1) {
    const updated = cleaned.replace(labelPattern, "").trim();

    if (updated === cleaned) {
      break;
    }

    cleaned = updated;
  }

  return cleaned;
}

function removeForbiddenOpeners(answer) {
  const openerPatterns = [
    /^\s*based\s+on\b.*(?:review|reviews|excerpts|context|provided).*$/i,
    /^\s*here\s+(?:is|are)\b.*$/i,
    /^\s*users?'?\s+responses?\s*:\s*$/i,
  ];
  const lines = String(answer || "").split(/\r?\n/);

  while (lines.length) {
    const firstLine = lines[0].trim();

    if (!firstLine) {
      lines.shift();
      continue;
    }

    if (!openerPatterns.some((pattern) => pattern.test(firstLine))) {
      break;
    }

    lines.shift();
  }

  return lines.join("\n").trim();
}

function removeMetaCommentary(answer) {
  const metaPatterns = [
    /^\s*note\s+that\b.*$/i,
    /^\s*note:\s+.*$/i,
    /^\s*this\s+answer\b.*$/i,
    /^\s*the\s+answer\b.*$/i,
    /^\s*the\s+user'?s\s+question\b.*$/i,
    /^\s*the\s+user\s+is\s+asking\b.*$/i,
    /^\s*the\s+prompt\b.*$/i,
    /^\s*here'?s\s+a\s+response\b.*$/i,
    /^\s*users?'?\s+responses?\s*:\s*$/i,
    /^\s*i\s+(?:will|should|must|need to)\b.*$/i,
  ];

  return String(answer || "")
    .split(/\r?\n/)
    .filter((line) => !metaPatterns.some((pattern) => pattern.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeForbiddenSections(answer) {
  return String(answer || "")
    .split(/^\s*recommendations?\s*:\s*$/im)[0]
    .split(/^\s*(?:buying\s+advice|suggestions?)\s*:\s*$/im)[0]
    .trim();
}

function removeUnsafeScriptArtifacts(answer) {
  let cleaned = String(answer || "").trim();

  if (!UNSAFE_SCRIPT_PATTERN.test(cleaned)) {
    return cleaned;
  }

  const firstUnsafeIndex = cleaned.search(UNSAFE_SCRIPT_PATTERN);
  const firstLatinIndex = cleaned.search(/[A-Za-z]/);

  if (firstUnsafeIndex !== -1 && (firstLatinIndex === -1 || firstUnsafeIndex < firstLatinIndex)) {
    cleaned = firstLatinIndex >= 0 ? cleaned.slice(firstLatinIndex).trim() : "";
  }

  return hasUnsafeScriptArtifact(cleaned) ? "" : cleaned;
}

function hasUnsafeScriptArtifact(answer) {
  return UNSAFE_SCRIPT_PATTERN.test(String(answer || ""));
}

function removeMarkdownEmphasis(answer) {
  return String(answer || "")
    .replace(/\*\*/g, "")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .trim();
}

function isQuestionEcho(answer, userQuestion) {
  const normalizedAnswer = normalizeEchoText(answer);
  const normalizedQuestion = normalizeEchoText(userQuestion);

  if (!normalizedAnswer || !normalizedQuestion) {
    return false;
  }

  if (normalizedAnswer === normalizedQuestion) {
    return true;
  }

  if (String(answer || "").trim().endsWith("?")) {
    const answerTerms = new Set(normalizedAnswer.split(/\s+/));
    const questionTerms = normalizedQuestion.split(/\s+/);
    const overlap = questionTerms.filter((term) => answerTerms.has(term)).length / questionTerms.length;

    return overlap >= 0.75;
  }

  return false;
}

function normalizeEchoText(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function detectQuestionSentiment(question) {
  const normalized = String(question || "").toLowerCase();

  if (/\b(?:complaint|complaints|concern|concerns|dislike|issue|issues|negative|problem|problems|risk|risks|bad|worst)\b/.test(normalized)) {
    return "negative";
  }

  if (/\b(?:benefit|best|good|great|happy|like|liked|likes|love|loved|positive|praise|pros|recommend|satisfied)\b/.test(normalized)) {
    return "positive";
  }

  return "neutral";
}
