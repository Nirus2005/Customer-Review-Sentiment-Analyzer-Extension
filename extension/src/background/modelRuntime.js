import {
  env,
  InterruptableStoppingCriteria,
  pipeline,
  TextStreamer,
} from "@huggingface/transformers";
import {
  GENERATION_OPTIONS,
  MODEL_CACHE_DB,
  MODEL_CACHE_VERSION,
  MODEL_CONFIG,
  MODEL_ROLES,
  MODEL_STATUS_STORE,
  RAG_LIMITS,
} from "../constants/ragConfig.js";
import { isDegenerateGeneratedText } from "../localRag/responseGuards.js";
import { buildReviewRagMessages } from "../prompts/reviewRagPrompts.js";
import { generateWithCloudApi, embedWithCloudApi, classifySentimentWithCloudApi } from "./cloudApi.js";

// We run CPU models in the service worker, so we skip local/remote checks.
// But we still don't use the cache that might be broken.
if ("useBrowserCache" in env) {
  env.useBrowserCache = true;
}

if ("useFSCache" in env) {
  env.useFSCache = false;
}

if ("useCustomCache" in env) {
  env.useCustomCache = false;
}

// We cannot use webgpu in the service worker context
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.proxy = false;
}

const runtimeState = {
  initializedAt: null,
  webgpuAvailable: false, // Force false for service worker
  pipelines: new Map(),
  loadingPromises: new Map(),
  activeGenerations: new Map(),
};

export function configureTransformersEnvironment() {
  // Configured at module scope
}

export async function markExtensionInstalled() {
  // Initialization hook for cache setup
}

async function getCloudCredentials() {
  const storageResult = await new Promise(resolve => {
    chrome.storage.local.get(["aiProvider", "aiApiKey", "aiBaseUrl", "aiModelName"], resolve);
  });
  const { aiProvider, aiApiKey, aiBaseUrl, aiModelName } = storageResult;
  const isCloud = Boolean(aiProvider && aiProvider !== "local" && aiApiKey);
  return { isCloud, aiProvider, aiApiKey, aiBaseUrl, aiModelName };
}

export async function initModels(roles = [
  MODEL_ROLES.EMBEDDING,
  MODEL_ROLES.SENTIMENT,
]) {
  const { isCloud } = await getCloudCredentials();
  
  if (isCloud) {
    // Skip loading local models if using cloud
    runtimeState.initializedAt = new Date().toISOString();
    return {
      ok: true,
      initializedAt: runtimeState.initializedAt,
      webgpuAvailable: false,
      models: {
        [MODEL_ROLES.EMBEDDING]: { ok: true, config: { model: "cloud" } },
        [MODEL_ROLES.SENTIMENT]: { ok: true, config: { model: "cloud" } },
      },
    };
  }

  const requestedRoles = normalizeRoles(roles);
  const results = {};

  for (const role of requestedRoles) {
    try {
      await getPipeline(role);
      results[role] = {
        ok: true,
        config: publicModelConfig(role),
      };
    } catch (error) {
      results[role] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        config: publicModelConfig(role),
      };
    }
  }

  runtimeState.initializedAt = new Date().toISOString();

  return {
    ok: true,
    initializedAt: runtimeState.initializedAt,
    webgpuAvailable: false,
    models: results,
  };
}

export async function getModelStatus() {
  const records = await getModelStatusRecords();

  return {
    ok: true,
    initializedAt: runtimeState.initializedAt,
    webgpuAvailable: false,
    loadedRoles: Array.from(runtimeState.pipelines.keys()),
    loadingRoles: Array.from(runtimeState.loadingPromises.keys()),
    cache: records,
  };
}

export async function embedTexts(texts) {
  const cleanTexts = normalizeTexts(texts);

  if (!cleanTexts.length) {
    return { ok: true, embeddings: [] };
  }

  const { isCloud, aiProvider, aiApiKey, aiBaseUrl } = await getCloudCredentials();
  
  if (isCloud) {
    const embeddings = await embedWithCloudApi(cleanTexts, aiProvider, aiApiKey, aiBaseUrl);
    return {
      ok: true,
      model: "cloud",
      embeddings,
    };
  }

  const extractor = await getPipeline(MODEL_ROLES.EMBEDDING);
  const output = await extractor(cleanTexts, {
    pooling: "mean",
    normalize: true,
  });

  return {
    ok: true,
    model: MODEL_CONFIG[MODEL_ROLES.EMBEDDING].model,
    embeddings: tensorToNestedArray(output, cleanTexts.length),
  };
}

export async function classifySentiment(texts) {
  const cleanTexts = normalizeTexts(texts);

  if (!cleanTexts.length) {
    return { ok: true, results: [] };
  }

  const { isCloud, aiProvider, aiApiKey, aiBaseUrl, aiModelName } = await getCloudCredentials();
  
  if (isCloud) {
    const results = await classifySentimentWithCloudApi(cleanTexts, aiProvider, aiApiKey, aiModelName, aiBaseUrl);
    return {
      ok: true,
      model: "cloud",
      results,
    };
  }

  const classifier = await getPipeline(MODEL_ROLES.SENTIMENT);
  const output = await classifier(cleanTexts);

  return {
    ok: true,
    model: MODEL_CONFIG[MODEL_ROLES.SENTIMENT].model,
    results: Array.isArray(output) ? output : [output],
  };
}

export async function streamGenerationToPort(port, message) {
  const requestId = message.requestId || crypto.randomUUID();

  const { isCloud, aiProvider, aiApiKey, aiBaseUrl, aiModelName } = await getCloudCredentials();

  if (isCloud) {
    const prompt = buildReviewRagMessages({
      context: message.context || "No review context available.",
      recentChat: message.recentChat || "No previous chat history.",
      conversationSummary: message.conversationSummary || "No earlier conversation summary.",
      sessionAnalytics: message.sessionAnalytics || "No session analytics available.",
      answerStyle: message.answerStyle || "Answer briefly in natural language.",
      userQuery: message.query || "",
      isCloud,
    });
    
    safePostMessage(port, {
      type: "START",
      requestId,
      model: "cloud",
    });
    return generateWithCloudApi(prompt, port, requestId, aiProvider, aiApiKey, aiModelName, aiBaseUrl);
  }

  const prompt = buildReviewRagMessages({
    context: message.context || "No review context available.",
    recentChat: message.recentChat || "No previous chat history.",
    conversationSummary: message.conversationSummary || "No earlier conversation summary.",
    sessionAnalytics: message.sessionAnalytics || "No session analytics available.",
    answerStyle: message.answerStyle || "Answer briefly in natural language.",
    userQuery: message.query || "",
    isCloud: false,
  });

  const generator = await getPipeline(MODEL_ROLES.GENERATOR);
  const generationState = {
    cancelled: false,
    errorSent: false,
    stoppingCriteria: new InterruptableStoppingCriteria(),
  };

  runtimeState.activeGenerations.set(requestId, generationState);
  const cancelOnDisconnect = () => {
    cancelGeneration(requestId);
  };
  port.onDisconnect.addListener(cancelOnDisconnect);

  let streamedText = "";
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (tokenText) => {
      if (generationState.cancelled) {
        return;
      }

      const token = extractGeneratedText(tokenText);

      if (!token) {
        return;
      }

      streamedText += token;

      if (isDegenerateGeneratedText(streamedText)) {
        generationState.errorSent = true;
        cancelGeneration(requestId);
        safePostMessage(port, {
          type: "ERROR",
          requestId,
          error: "Local generator produced repetitive text.",
        });
        return;
      }

      safePostMessage(port, {
        type: "TOKEN",
        requestId,
        token,
        text: streamedText,
      });
    },
  });

  try {
    const generated = await generator(prompt, {
      max_new_tokens: message.maxNewTokens || RAG_LIMITS.maxNewTokens,
      ...GENERATION_OPTIONS,
      stopping_criteria: generationState.stoppingCriteria,
      streamer,
    });

    if (!generationState.cancelled) {
      safePostMessage(port, {
        type: "DONE",
        requestId,
        text: streamedText || extractGeneratedText(generated),
      });
    } else if (!generationState.errorSent) {
      safePostMessage(port, {
        type: "CANCELLED",
        requestId,
      });
    }
  } catch (error) {
    safePostMessage(port, {
      type: "ERROR",
      requestId,
      error: error.message,
    });
  } finally {
    runtimeState.activeGenerations.delete(requestId);
    port.onDisconnect.removeListener(cancelOnDisconnect);
  }
}

export function cancelGeneration(requestId) {
  const generationState = runtimeState.activeGenerations.get(requestId);

  if (!generationState) {
    return false;
  }

  generationState.cancelled = true;
  generationState.stoppingCriteria.interrupt();
  return true;
}

async function getPipeline(role) {
  const normalizedRole = normalizeRole(role);

  if (runtimeState.pipelines.has(normalizedRole)) {
    return runtimeState.pipelines.get(normalizedRole);
  }

  if (runtimeState.loadingPromises.has(normalizedRole)) {
    return runtimeState.loadingPromises.get(normalizedRole);
  }

  const loadPromise = loadPipeline(normalizedRole);
  runtimeState.loadingPromises.set(normalizedRole, loadPromise);

  try {
    const loadedPipeline = await loadPromise;
    runtimeState.pipelines.set(normalizedRole, loadedPipeline);
    return loadedPipeline;
  } finally {
    runtimeState.loadingPromises.delete(normalizedRole);
  }
}

async function loadPipeline(role) {
  const config = MODEL_CONFIG[role];

  if (!config) {
    throw new Error(`Unsupported model role: ${role}`);
  }

  if (role === MODEL_ROLES.GENERATOR && !runtimeState.webgpuAvailable) {
    await writeModelCacheRecord(role, {
      ...publicModelConfig(role),
      status: "unavailable",
      error: "WebGPU is not available in this extension service worker context.",
      updatedAt: new Date().toISOString(),
    });

    throw new Error(
      "WebGPU is not available in this extension service worker context. " +
      "Run generation from an offscreen document or dedicated worker."
    );
  }

  await writeModelCacheRecord(role, {
    ...publicModelConfig(role),
    status: "loading",
    updatedAt: new Date().toISOString(),
  });

  const loadedPipeline = await pipeline(config.task, config.model, {
    device: config.device,
    dtype: config.dtype,
    progress_callback: (progress) => {
      writeModelCacheRecord(role, {
        ...publicModelConfig(role),
        status: "loading",
        progress,
        updatedAt: new Date().toISOString(),
      }).catch(console.warn);
    },
  });

  await writeModelCacheRecord(role, {
    ...publicModelConfig(role),
    status: "ready",
    readyAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return loadedPipeline;
}

function tensorToNestedArray(output, expectedRows) {
  if (typeof output?.tolist === "function") {
    return output.tolist();
  }

  if (!output?.data || !output?.dims?.length) {
    return [];
  }

  const dims = output.dims;
  const rows = dims.length > 1 ? dims[0] : expectedRows;
  const columns = dims.length > 1 ? dims[dims.length - 1] : output.data.length / rows;
  const embeddings = [];

  for (let row = 0; row < rows; row += 1) {
    const start = row * columns;
    embeddings.push(Array.from(output.data.slice(start, start + columns)));
  }

  return embeddings;
}

function extractGeneratedText(generated) {
  return textFromGeneratedValue(generated).trim();
}

function textFromGeneratedValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const assistantMessage = [...value].reverse().find((item) => (
      String(item?.role || "").toLowerCase() === "assistant" &&
      item.content !== undefined
    ));

    if (assistantMessage) {
      return textFromGeneratedValue(assistantMessage.content);
    }

    const textParts = value
      .map(textFromGeneratedValue)
      .filter(Boolean);

    return textParts.length > 1 ? textParts.join("") : textParts[0] || "";
  }

  if (typeof value === "object") {
    for (const key of ["generated_text", "message", "content", "text", "token", "token_text", "output_text"]) {
      if (value[key] !== undefined) {
        return textFromGeneratedValue(value[key]);
      }
    }
  }

  return "";
}

function normalizeTexts(texts) {
  return (Array.isArray(texts) ? texts : [texts])
    .map((text) => String(text || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function normalizeRoles(roles) {
  return (Array.isArray(roles) ? roles : [roles])
    .map(normalizeRole)
    .filter(Boolean);
}

function normalizeRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();

  if (!MODEL_CONFIG[normalizedRole]) throw new Error(`Unsupported model role: ${role}`);

  return normalizedRole;
}

function publicModelConfig(role) {
  const config = MODEL_CONFIG[role];

  return {
    role,
    task: config.task,
    model: config.model,
    device: config.device,
    dtype: config.dtype,
  };
}

async function getModelStatusRecords() {
  const db = await openModelCacheDb();
  return readAllFromStore(db, MODEL_STATUS_STORE);
}

async function writeModelCacheRecord(key, value) {
  const db = await openModelCacheDb();

  await writeToStore(db, MODEL_STATUS_STORE, {
    id: key,
    ...value,
  });
}

function openModelCacheDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODEL_CACHE_DB, MODEL_CACHE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(MODEL_STATUS_STORE)) {
        db.createObjectStore(MODEL_STATUS_STORE, {
          keyPath: "id",
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeToStore(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.put(value);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function readAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function safePostMessage(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The popup may have closed or cancelled the port.
  }
}
