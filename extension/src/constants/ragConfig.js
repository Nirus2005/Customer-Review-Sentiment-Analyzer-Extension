export const MESSAGE_TYPES = {
  OPEN_POPUP_FOR_SELECTION: "VERDICT/OPEN_POPUP_FOR_SELECTION",
  INIT_MODELS: "LOCAL_RAG/INIT_MODELS",
  MODEL_STATUS: "LOCAL_RAG/MODEL_STATUS",
  EMBED_TEXTS: "LOCAL_RAG/EMBED_TEXTS",
  CLASSIFY_SENTIMENT: "LOCAL_RAG/CLASSIFY_SENTIMENT",
  GENERATE: "LOCAL_RAG/GENERATE",
  CANCEL_GENERATION: "LOCAL_RAG/CANCEL_GENERATION",
};

export const SELECTION_LAUNCH_STORAGE_KEY = "verdict.selectionLaunch";

export const PORT_NAMES = {
  GENERATION: "LOCAL_RAG/GENERATION_STREAM",
};

export const MODEL_ROLES = {
  EMBEDDING: "embedding",
  SENTIMENT: "sentiment",
  GENERATOR: "generator",
};

export const MODEL_CONFIG = {
  [MODEL_ROLES.EMBEDDING]: {
    task: "feature-extraction",
    model: "Xenova/all-MiniLM-L6-v2",
    device: "wasm",
    dtype: "q8",
  },
  [MODEL_ROLES.SENTIMENT]: {
    task: "sentiment-analysis",
    model: "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
    device: "wasm",
    dtype: "q8",
  },
  [MODEL_ROLES.GENERATOR]: {
    task: "text-generation",
    model: "onnx-community/Qwen2.5-0.5B-Instruct",
    device: "webgpu",
    dtype: "q4f16",
  },
};

export const RAG_LIMITS = {
  topK: 6,
  maxContextTokens: 1800,
  minRelevance: 0.25,
  relevanceScoreDrop: 0.2,
  fetchMultiplier: 2,
  minSourceCount: 2,
  sourceScoreFloor: 0.08,
  maxSourceCount: 12,
  maxNewTokens: 220,
  maxRecentMessages: 10,
  maxSummaryTokens: 180,
  displaySourceCount: 4,
  generationTimeoutMs: 150_000,
  sentimentBatchSize: 10,
  embeddingBatchSize: 16,
  fullIndexReviewLimit: 50,
  localInitialIndexedReviews: 20,
  maxInitialIndexedReviews: 50,
  maxLazyIndexedReviewsPerQuery: 32,
  maxStoredBacklogReviews: 3000,
};

export const INTENT_LIMITS = {
  balanced: {
    topK: 6,
    maxSourceCount: 12,
    minSourceCount: RAG_LIMITS.minSourceCount,
    maxContextTokens: 1800,
    maxNewTokens: 200,
  },
  detailed: {
    topK: 6,
    maxSourceCount: 12,
    minSourceCount: RAG_LIMITS.minSourceCount,
    maxContextTokens: 1800,
    maxNewTokens: 200,
  },
  sources: {
    topK: 6,
    maxSourceCount: 12,
    minSourceCount: RAG_LIMITS.minSourceCount,
    maxContextTokens: 1800,
    maxNewTokens: 180,
  },
  negative: {
    topK: RAG_LIMITS.topK,
    maxSourceCount: 10,
    minSourceCount: RAG_LIMITS.minSourceCount,
    maxContextTokens: 1300,
    maxNewTokens: 160,
  },
  positive: {
    topK: RAG_LIMITS.topK,
    maxSourceCount: 10,
    minSourceCount: RAG_LIMITS.minSourceCount,
    maxContextTokens: 1300,
    maxNewTokens: 160,
  },
  overall: {
    topK: 6,
    maxSourceCount: 8,
    minSourceCount: 2,
    maxContextTokens: 1000,
    maxNewTokens: 140,
  },
  neutral: {
    topK: 6,
    maxSourceCount: 8,
    minSourceCount: 2,
    maxContextTokens: 900,
    maxNewTokens: 120,
  },
};

export const ANSWER_STYLE_BY_INTENT = {
  negative: (
    "Write one short paragraph summarizing complaint/dislike themes only. " +
    "Do not list individual reviews, chunks, or customer comments. " +
    "Do not use Positive/Negative/Mixed labels. " +
    "Do not use bullets, numbering, headings, or Markdown bold."
  ),
  positive: (
    "Write one short paragraph summarizing what customers like. " +
    "Do not list individual reviews, chunks, or exact comments. " +
    "Do not use Positive/Negative/Mixed labels. " +
    "Do not use bullets, numbering, headings, or Markdown bold."
  ),
  balanced: (
    "Summarize pros and cons as themes, not as individual reviews or chunks. " +
    "Do not quote exact comments. Do not use Markdown bold."
  ),
  detailed: (
    "Answer the specific subject in the user's question directly. " +
    "Summarize only what the retrieved reviews say about that subject. " +
    "Do not switch to unrelated complaint or praise themes. Do not quote exact comments. " +
    "Do not use Markdown bold."
  ),
  sources: (
    "Answer briefly, then let the separate sources panel show exact comments. " +
    "Do not use Markdown bold."
  ),
  neutral: (
    "Answer the specific subject in the user's question directly in 1-2 short sentences. " +
    "If the relevant excerpts are positive, say that directly. If they are negative or mixed, say that directly. " +
    "Do not turn neutral feature or material questions into complaint summaries. " +
    "Do not quote exact comments. Do not use Markdown bold."
  ),
  default: (
    "Answer the user's specific question briefly in natural language. " +
    "Do not summarize unrelated themes. Do not quote exact comments unless asked. " +
    "Do not use Markdown bold."
  ),
};

export const GENERATION_OPTIONS = {
  do_sample: false,
  temperature: 0,
  repetition_penalty: 1.12,
  no_repeat_ngram_size: 4,
  return_full_text: false,
};

export const MODEL_CACHE_DB = "local-first-rag-model-cache";
export const MODEL_CACHE_VERSION = 1;
export const MODEL_STATUS_STORE = "model_status";
