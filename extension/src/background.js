import {
  env,
  pipeline,
  TextStreamer,
} from "@huggingface/transformers";

const MESSAGE_TYPES = {
  INIT_MODELS: "LOCAL_RAG/INIT_MODELS",
  MODEL_STATUS: "LOCAL_RAG/MODEL_STATUS",
  EMBED_TEXTS: "LOCAL_RAG/EMBED_TEXTS",
  CLASSIFY_SENTIMENT: "LOCAL_RAG/CLASSIFY_SENTIMENT",
  GENERATE: "LOCAL_RAG/GENERATE",
};

const PORT_NAMES = {
  GENERATION: "LOCAL_RAG/GENERATION_STREAM",
};

const MODEL_ROLES = {
  EMBEDDING: "embedding",
  SENTIMENT: "sentiment",
  GENERATOR: "generator",
};

const MODEL_CONFIG = {
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
    model: "Xenova/SmolLM2-135M-Instruct",
    device: "webgpu",
    dtype: "q4f16",
  },
};

const MODEL_CACHE_DB = "local-first-rag-model-cache";
const MODEL_CACHE_VERSION = 1;
const MODEL_STATUS_STORE = "model_status";
const DEFAULT_MAX_NEW_TOKENS = 220;

const runtimeState = {
  initializedAt: null,
  webgpuAvailable: Boolean(globalThis.navigator?.gpu),
  pipelines: new Map(),
  loadingPromises: new Map(),
};

configureTransformersEnvironment();

chrome.runtime.onInstalled.addListener(() => {
  writeModelCacheRecord("extension", {
    status: "installed",
    installedAt: new Date().toISOString(),
    cacheMode: "browser-indexeddb",
  }).catch(console.warn);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleRuntimeMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAMES.GENERATION) {
    return;
  }

  port.onMessage.addListener((message) => {
    if (message?.type !== MESSAGE_TYPES.GENERATE) {
      return;
    }

    streamGenerationToPort(port, message).catch((error) => {
      port.postMessage({
        type: "ERROR",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
});

async function handleRuntimeMessage(message) {
  switch (message?.type) {
    case MESSAGE_TYPES.INIT_MODELS:
      return initModels(message.roles);

    case MESSAGE_TYPES.MODEL_STATUS:
      return getModelStatus();

    case MESSAGE_TYPES.EMBED_TEXTS:
      return embedTexts(message.texts || []);

    case MESSAGE_TYPES.CLASSIFY_SENTIMENT:
      return classifySentiment(message.texts || []);

    default:
      return {
        ok: false,
        error: `Unknown message type: ${message?.type || "missing"}`,
      };
  }
}

function configureTransformersEnvironment() {
  env.allowRemoteModels = true;
  env.allowLocalModels = false;

  // Transformers.js caches model artifacts in the browser. Keep our own
  // IndexedDB model-status records alongside that cache so UI code can tell
  // whether models have been warmed before.
  if ("useBrowserCache" in env) {
    env.useBrowserCache = true;
  }

  if ("useFSCache" in env) {
    env.useFSCache = false;
  }

  if ("useCustomCache" in env) {
    env.useCustomCache = false;
  }

  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.proxy = false;
  }
}

async function initModels(roles = [
  MODEL_ROLES.EMBEDDING,
  MODEL_ROLES.SENTIMENT,
]) {
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
    webgpuAvailable: runtimeState.webgpuAvailable,
    models: results,
  };
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
      "Run generation from an offscreen document or dedicated worker.",
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

async function embedTexts(texts) {
  const cleanTexts = normalizeTexts(texts);

  if (!cleanTexts.length) {
    return {
      ok: true,
      embeddings: [],
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

async function classifySentiment(texts) {
  const cleanTexts = normalizeTexts(texts);

  if (!cleanTexts.length) {
    return {
      ok: true,
      results: [],
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

async function streamGenerationToPort(port, message) {
  const requestId = message.requestId || crypto.randomUUID();
  const generator = await getPipeline(MODEL_ROLES.GENERATOR);
  const prompt = buildGenerationPrompt({
    query: message.query || "",
    chunks: message.chunks || [],
    analytics: message.analytics || "",
  });

  port.postMessage({
    type: "START",
    requestId,
    model: MODEL_CONFIG[MODEL_ROLES.GENERATOR].model,
  });

  let streamedText = "";
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (tokenText) => {
      streamedText += tokenText;
      port.postMessage({
        type: "TOKEN",
        requestId,
        token: tokenText,
        text: streamedText,
      });
    },
  });

  const generated = await generator(prompt, {
    max_new_tokens: message.maxNewTokens || DEFAULT_MAX_NEW_TOKENS,
    do_sample: false,
    temperature: 0,
    repetition_penalty: 1.08,
    streamer,
  });

  port.postMessage({
    type: "DONE",
    requestId,
    text: streamedText || extractGeneratedText(generated),
  });
}

function buildGenerationPrompt({ query, chunks, analytics }) {
  const context = chunks
    .map((chunk, index) => {
      const metadata = chunk.metadata || {};
      const labels = [
        `Chunk ${index + 1}`,
        metadata.rating ? `rating: ${metadata.rating}/${metadata.rating_max || 5}` : "",
        metadata.upvotes ? `upvotes: ${metadata.upvotes}` : "",
        metadata.helpfulness ? `helpfulness: ${metadata.helpfulness}` : "",
      ]
        .filter(Boolean)
        .join(" | ");

      return `[${labels}]\n${chunk.text || chunk.page_content || ""}`;
    })
    .join("\n\n");

  return [
    {
      role: "system",
      content: (
        "You are a local private review assistant. Answer only from the provided chunks. " +
        "Summarize themes; do not quote long comments; do not invent facts."
      ),
    },
    {
      role: "user",
      content: [
        `<session_analytics>${analytics || "No analytics available."}</session_analytics>`,
        `<chunks>${context || "No relevant chunks."}</chunks>`,
        `<question>${query}</question>`,
        "Return only the user-facing answer.",
      ].join("\n\n"),
    },
  ];
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
  const first = Array.isArray(generated) ? generated[0] : generated;
  return first?.generated_text || first?.text || "";
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

  if (!MODEL_CONFIG[normalizedRole]) {
    throw new Error(`Unsupported model role: ${role}`);
  }

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

async function getModelStatus() {
  const db = await openModelCacheDb();
  const records = await readAllFromStore(db, MODEL_STATUS_STORE);

  return {
    ok: true,
    initializedAt: runtimeState.initializedAt,
    webgpuAvailable: runtimeState.webgpuAvailable,
    loadedRoles: Array.from(runtimeState.pipelines.keys()),
    loadingRoles: Array.from(runtimeState.loadingPromises.keys()),
    cache: records,
  };
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
