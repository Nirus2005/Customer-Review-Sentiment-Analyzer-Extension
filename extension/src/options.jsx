import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import {
  AI_KEY_STORAGE_MODES,
  getEffectiveAiSettings,
  maskApiKey,
  removeSavedAiKey,
  saveAiSettings,
} from "./services/aiSettingsStorage.js";

const PROVIDER_DEFAULTS = {
  local: {
    label: "Local browser models",
    modelName: "",
    embeddingModelName: "",
    baseUrl: "",
    apiFormat: "local",
    supportsEmbeddings: true,
  },
  gemini: {
    label: "Google Gemini API",
    modelName: "gemini-1.5-flash",
    embeddingModelName: "text-embedding-004",
    baseUrl: "",
    apiFormat: "gemini",
    supportsEmbeddings: true,
  },
  openai: {
    label: "OpenAI API",
    modelName: "gpt-4o-mini",
    embeddingModelName: "text-embedding-3-small",
    baseUrl: "https://api.openai.com/v1",
    apiFormat: "openai-compatible",
    supportsEmbeddings: true,
  },
  anthropic: {
    label: "Anthropic API",
    modelName: "claude-3-5-haiku-latest",
    embeddingModelName: "",
    baseUrl: "",
    apiFormat: "anthropic",
    supportsEmbeddings: false,
  },
  groq: {
    label: "Groq API",
    modelName: "llama-3.3-70b-versatile",
    embeddingModelName: "",
    baseUrl: "https://api.groq.com/openai/v1",
    apiFormat: "openai-compatible",
    supportsEmbeddings: false,
  },
  openrouter: {
    label: "OpenRouter API",
    modelName: "openai/gpt-5.2",
    embeddingModelName: "",
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "openai-compatible",
    supportsEmbeddings: false,
  },
  together: {
    label: "Together AI API",
    modelName: "MiniMaxAI/MiniMax-M3",
    embeddingModelName: "",
    baseUrl: "https://api.together.ai/v1",
    apiFormat: "openai-compatible",
    supportsEmbeddings: true,
  },
  mistral: {
    label: "Mistral AI API",
    modelName: "mistral-small-latest",
    embeddingModelName: "mistral-embed",
    baseUrl: "https://api.mistral.ai/v1",
    apiFormat: "openai-compatible",
    supportsEmbeddings: true,
  },
  deepseek: {
    label: "DeepSeek API",
    modelName: "deepseek-chat",
    embeddingModelName: "",
    baseUrl: "https://api.deepseek.com/v1",
    apiFormat: "openai-compatible",
    supportsEmbeddings: false,
  },
  xai: {
    label: "xAI API",
    modelName: "grok-4-latest",
    embeddingModelName: "",
    baseUrl: "https://api.x.ai/v1",
    apiFormat: "openai-compatible",
    supportsEmbeddings: false,
  },
  cerebras: {
    label: "Cerebras API",
    modelName: "llama-3.3-70b",
    embeddingModelName: "",
    baseUrl: "https://api.cerebras.ai/v1",
    apiFormat: "openai-compatible",
    supportsEmbeddings: false,
  },
  custom: {
    label: "Custom OpenAI-compatible API",
    modelName: "",
    embeddingModelName: "",
    baseUrl: "",
    apiFormat: "openai-compatible",
    supportsEmbeddings: null,
  },
};

const EMPTY_MODEL_SUGGESTIONS = {
  chat: [],
  embedding: [],
};

const PROVIDER_LABELS = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_DEFAULTS).map(([key, value]) => [key, value.label]),
  ),
};

const OPENAI_COMPATIBLE_PROVIDERS = new Set(
  Object.entries(PROVIDER_DEFAULTS)
    .filter(([, value]) => value.apiFormat === "openai-compatible")
    .map(([key]) => key),
);

export function SettingsPanel({ embedded = false, onSaved }) {
  const [provider, setProvider] = useState("local");
  const [apiKey, setApiKey] = useState("");
  const [keyStorageMode, setKeyStorageMode] = useState(AI_KEY_STORAGE_MODES.LOCAL);
  const [savedKeyPreview, setSavedKeyPreview] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [embeddingModelName, setEmbeddingModelName] = useState("");
  const [modelSuggestions, setModelSuggestions] = useState(EMPTY_MODEL_SUGGESTIONS);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [modelLookupStatus, setModelLookupStatus] = useState("");
  const [lastFallback, setLastFallback] = useState("");
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const providerDefaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.local;
  const isCloudProvider = provider !== "local";
  const supportsProviderEmbeddings = providerSupportsEmbeddings(provider);
  const effectiveEmbeddingModelName = embeddingModelName.trim() || providerDefaults.embeddingModelName;
  const usesLocalEmbeddings = isCloudProvider &&
    (supportsProviderEmbeddings === false || !effectiveEmbeddingModelName);
  const detectedProvider = detectProviderFromKey(apiKey);
  const keyProviderMismatch = Boolean(
    detectedProvider &&
    isCloudProvider &&
    provider !== "custom" &&
    !providersAreCompatible(detectedProvider, provider)
  );

  useEffect(() => {
    let cancelled = false;

    async function loadOptions() {
      try {
        const result = await getEffectiveAiSettings();
        const savedProvider = result.aiProvider || "local";

        if (cancelled) {
          return;
        }

        setProvider(savedProvider);
        setApiKey("");
        setSavedKeyPreview(maskApiKey(result.aiApiKey));
        setKeyStorageMode(result.aiKeyStorageMode || AI_KEY_STORAGE_MODES.LOCAL);
        setBaseUrl(result.aiBaseUrl || "");
        setModelName(result.aiModelName || PROVIDER_DEFAULTS[savedProvider]?.modelName || "");
        setEmbeddingModelName(
          result.aiEmbeddingModelName ||
          PROVIDER_DEFAULTS[savedProvider]?.embeddingModelName ||
          "",
        );
        setLastFallback(result.aiLastFallbackReason || "");
      } catch (error) {
        if (!cancelled) {
          setStatus(error.message || "Could not load saved settings.");
        }
      }
    }

    loadOptions();

    return () => {
      cancelled = true;
    };
  }, []);

  async function saveOptions() {
    setStatus("");
    setIsSaving(false);
    const storedSettings = await getEffectiveAiSettings().catch(() => ({}));
    const nextApiKey = apiKey.trim();
    const preservedApiKey = savedKeyPreview ? storedSettings.aiApiKey || "" : "";
    const keyToSave = isCloudProvider ? nextApiKey || preservedApiKey : "";

    if (isCloudProvider && !keyToSave) {
      setStatus("Enter an API key before saving.");
      return;
    }

    if (isCloudProvider && !modelName.trim()) {
      setStatus("Enter a chat model name before saving.");
      return;
    }

    if (provider === "custom" && !baseUrl.trim()) {
      setStatus("Enter a base URL for the custom provider.");
      return;
    }

    if (provider === "custom") {
      const granted = await requestCustomProviderPermission(baseUrl);

      if (!granted) {
        setStatus("Custom provider permission was not granted.");
        return;
      }
    }

    setIsSaving(true);
    setStatus("Saving settings...");

    try {
      const nextStorageMode = isCloudProvider
        ? keyStorageMode
        : AI_KEY_STORAGE_MODES.LOCAL;

      await saveAiSettings({
        aiProvider: provider,
        aiApiKey: keyToSave,
        aiBaseUrl: provider === "custom"
          ? baseUrl.trim().replace(/\/+$/, "")
          : providerDefaults.baseUrl,
        aiModelName: modelName.trim(),
        aiEmbeddingModelName: supportsProviderEmbeddings === false ? "" : embeddingModelName.trim(),
        aiKeyStorageMode: nextStorageMode,
      });

      setLastFallback("");
      setApiKey("");
      setKeyStorageMode(nextStorageMode);
      setSavedKeyPreview(maskApiKey(keyToSave));
      window.setTimeout(() => {
        setIsSaving(false);
        setStatus("Settings saved.");

        if (onSaved) {
          onSaved();
          return;
        }

        setTimeout(() => setStatus(""), 3000);
      }, 850);
    } catch (error) {
      setIsSaving(false);
      setStatus(error.message || "Could not save settings.");
    }
  }

  function handleProviderChange(event) {
    const nextProvider = event.target.value;
    const defaults = PROVIDER_DEFAULTS[nextProvider] || PROVIDER_DEFAULTS.local;

    setProvider(nextProvider);
    setModelName(defaults.modelName);
    setEmbeddingModelName(defaults.embeddingModelName);
    setBaseUrl(defaults.baseUrl);
    setModelSuggestions(EMPTY_MODEL_SUGGESTIONS);
    setModelLookupStatus("");

    if (nextProvider !== provider) {
      setApiKey("");
      setSavedKeyPreview("");
    }
  }

  async function handleApiKeyFile(event) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const text = await file.text();
    setApiKey(text.trim());
    setStatus("API key imported. Save options to use it.");
    event.target.value = "";
  }

  async function suggestModels() {
    setStatus("");
    setModelLookupStatus("");
    setModelSuggestions(EMPTY_MODEL_SUGGESTIONS);

    if (!isCloudProvider) {
      return;
    }

    const lookupApiKey = await getApiKeyForAction();

    if (!lookupApiKey) {
      setModelLookupStatus("Enter an API key first.");
      return;
    }

    if (provider === "custom" && !baseUrl.trim()) {
      setModelLookupStatus("Enter a base URL for the custom provider.");
      return;
    }

    if (provider === "custom") {
      const granted = await requestCustomProviderPermission(baseUrl);

      if (!granted) {
        setModelLookupStatus("Custom provider permission was not granted.");
        return;
      }
    }

    setIsFetchingModels(true);

    try {
      const suggestions = await fetchProviderModels({
        provider,
        apiKey: lookupApiKey,
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
      });
      const preferredChatModel = choosePreferredChatModel(suggestions.chat, provider);
      const preferredEmbeddingModel = choosePreferredEmbeddingModel(suggestions.embedding, provider);

      setModelSuggestions(suggestions);

      if (preferredChatModel) {
        setModelName(preferredChatModel);
      }

      if (preferredEmbeddingModel && provider !== "anthropic") {
        setEmbeddingModelName(preferredEmbeddingModel);
      }

      setModelLookupStatus(buildModelLookupSuccessMessage(suggestions));
    } catch (error) {
      setModelLookupStatus(formatModelLookupError(error, provider));
    } finally {
      setIsFetchingModels(false);
    }
  }

  async function getApiKeyForAction() {
    const nextApiKey = apiKey.trim();

    if (nextApiKey) {
      return nextApiKey;
    }

    if (!savedKeyPreview) {
      return "";
    }

    const settings = await getEffectiveAiSettings();
    return settings.aiApiKey || "";
  }

  async function handleRemoveSavedKey() {
    setStatus("Removing saved key...");
    setIsSaving(true);

    try {
      await removeSavedAiKey();
      setApiKey("");
      setSavedKeyPreview("");
      setKeyStorageMode(AI_KEY_STORAGE_MODES.LOCAL);
      setLastFallback("");
      setStatus("Saved API key removed.");

      setTimeout(() => setStatus(""), 3000);
    } catch (error) {
      setStatus(error.message || "Could not remove saved key.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className={embedded ? "space-y-3 rounded-lg border border-zinc-200 bg-white p-3 shadow-sm" : "mx-auto max-w-xl space-y-4 rounded-lg border border-zinc-200 bg-white p-6 shadow-md"}>
      <h1 className={embedded ? "sr-only" : "mb-4 text-2xl font-bold"}>Settings</h1>

      <div>
        <label className="block text-sm font-medium text-zinc-700">AI Provider</label>
        <select
          value={provider}
          onChange={handleProviderChange}
          className="mt-1 block w-full rounded-md border border-zinc-200 bg-white p-2 text-zinc-950 shadow-sm"
        >
          <option value="local">Local browser models</option>
          <option value="openai">OpenAI API</option>
          <option value="gemini">Google Gemini API</option>
          <option value="anthropic">Anthropic API</option>
          <option value="groq">Groq API</option>
          <option value="openrouter">OpenRouter API</option>
          <option value="together">Together AI API</option>
          <option value="mistral">Mistral AI API</option>
          <option value="deepseek">DeepSeek API</option>
          <option value="xai">xAI API</option>
          <option value="cerebras">Cerebras API</option>
          <option value="custom">Custom OpenAI-compatible API</option>
        </select>
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs leading-snug text-amber-950">
          Local AI runs entirely in your browser, but it can be slow and time consuming for preprocessing and chat.
          Cloud APIs are usually faster and more capable. Retrieval embeddings use the selected embedding API when
          available, otherwise local embeddings are used automatically.
        </p>
      </div>

      {isCloudProvider && (
        <>
          <div>
            <label className="block text-sm font-medium text-zinc-700">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className="mt-1 block w-full rounded-md border border-zinc-200 bg-white p-2 text-zinc-950 shadow-sm"
              placeholder={savedKeyPreview ? `Saved as ${savedKeyPreview}. Enter a new key to replace it.` : "Enter your API key"}
            />
            {savedKeyPreview && (
              <p className="mt-2 text-xs leading-snug text-zinc-600">
                Saved key: <span className="font-mono font-semibold text-zinc-900">{savedKeyPreview}</span>
              </p>
            )}
            {savedKeyPreview && apiKey.trim() && (
              <p className="mt-1 text-xs leading-snug text-zinc-500">
                New key entered. Save to replace the saved key.
              </p>
            )}
            <div className="mt-3 grid gap-2" role="radiogroup" aria-label="API key storage">
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-200 bg-white p-2 text-sm text-zinc-800 shadow-sm hover:bg-zinc-50">
                <input
                  type="radio"
                  name="api-key-storage"
                  value={AI_KEY_STORAGE_MODES.LOCAL}
                  checked={keyStorageMode === AI_KEY_STORAGE_MODES.LOCAL}
                  onChange={() => setKeyStorageMode(AI_KEY_STORAGE_MODES.LOCAL)}
                  className="mt-1 accent-zinc-950"
                />
                <span>
                  <span className="block font-semibold">Remember API key on this device</span>
                  <span className="block text-xs leading-snug text-zinc-500">
                    Stored locally in this Chrome profile. Not synced by Verdict.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-200 bg-white p-2 text-sm text-zinc-800 shadow-sm hover:bg-zinc-50">
                <input
                  type="radio"
                  name="api-key-storage"
                  value={AI_KEY_STORAGE_MODES.SESSION}
                  checked={keyStorageMode === AI_KEY_STORAGE_MODES.SESSION}
                  onChange={() => setKeyStorageMode(AI_KEY_STORAGE_MODES.SESSION)}
                  className="mt-1 accent-zinc-950"
                />
                <span>
                  <span className="block font-semibold">Use only for this browser session</span>
                  <span className="block text-xs leading-snug text-zinc-500">
                    Cleared when the session ends. Verdict still does not sync it.
                  </span>
                </span>
              </label>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <label className="inline-flex cursor-pointer items-center rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 shadow-sm hover:bg-zinc-50">
                Import key file
                <input
                  type="file"
                  accept=".txt,.key,.env,text/plain"
                  onChange={handleApiKeyFile}
                  className="sr-only"
                />
              </label>
              <button
                type="button"
                onClick={handleRemoveSavedKey}
                disabled={isSaving || !savedKeyPreview}
                className="inline-flex items-center rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 shadow-sm hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove saved key
              </button>
            </div>
            <button
              type="button"
              onClick={suggestModels}
              disabled={isFetchingModels}
              className="mt-2 inline-flex items-center rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isFetchingModels ? "Checking..." : "Suggest models"}
            </button>
            {keyProviderMismatch && (
              <p className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                This key looks like a {PROVIDER_LABELS[detectedProvider]} key, but {PROVIDER_LABELS[provider]} is selected.
              </p>
            )}
            {modelLookupStatus && (
              <p className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600">
                {modelLookupStatus}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700">Chat Model</label>
            <input
              type="text"
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
              list="chat-model-suggestions"
              className="mt-1 block w-full rounded-md border border-zinc-200 bg-white p-2 text-zinc-950 shadow-sm"
              placeholder="e.g. gpt-4o-mini"
            />
            <ModelDatalist id="chat-model-suggestions" models={modelSuggestions.chat} />
            <ModelSuggestions
              models={modelSuggestions.chat}
              selectedModel={modelName}
              onSelect={setModelName}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-700">Embedding Model</label>
            <input
              type="text"
              value={embeddingModelName}
              onChange={(event) => setEmbeddingModelName(event.target.value)}
              disabled={supportsProviderEmbeddings === false}
              list="embedding-model-suggestions"
              className="mt-1 block w-full rounded-md border border-zinc-200 bg-white p-2 text-zinc-950 shadow-sm disabled:bg-zinc-100 disabled:text-zinc-500"
              placeholder={supportsProviderEmbeddings === false ? "Local embeddings will be used" : "e.g. text-embedding-3-small"}
            />
            <ModelDatalist id="embedding-model-suggestions" models={modelSuggestions.embedding} />
            <ModelSuggestions
              models={modelSuggestions.embedding}
              selectedModel={embeddingModelName}
              onSelect={setEmbeddingModelName}
            />
            {usesLocalEmbeddings && (
              <p className="mt-1 text-xs text-zinc-500">
                Local embeddings will be used for retrieval with this provider.
              </p>
            )}
          </div>
        </>
      )}

      {OPENAI_COMPATIBLE_PROVIDERS.has(provider) && provider !== "openai" && (
        <div>
          <label className="block text-sm font-medium text-zinc-700">
            {provider === "custom" ? "Base URL" : "Provider Base URL"}
          </label>
          <input
            type="text"
            value={provider === "custom" ? baseUrl : providerDefaults.baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            disabled={provider !== "custom"}
            className="mt-1 block w-full rounded-md border border-zinc-200 bg-white p-2 text-zinc-950 shadow-sm disabled:bg-zinc-100 disabled:text-zinc-500"
            placeholder="e.g. https://api.together.ai/v1"
          />
        </div>
      )}

      {lastFallback && (
        <p className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-800">
          {lastFallback}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={saveOptions}
          disabled={isSaving}
          className="inline-flex min-w-20 items-center justify-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-sm font-semibold text-white hover:bg-black disabled:cursor-wait disabled:opacity-80"
        >
          {isSaving && <span className="size-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
          {isSaving ? "Saving" : "Save"}
        </button>
        {status && <span className="ml-4 text-sm text-zinc-700">{status}</span>}
      </div>
    </div>
  );
}

function requestCustomProviderPermission(baseUrl) {
  if (!chrome.permissions?.request) {
    return Promise.resolve(true);
  }

  let originPattern = "";

  try {
    const url = new URL(baseUrl);
    originPattern = `${url.protocol}//${url.hostname}/*`;
  } catch {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    chrome.permissions.request({
      origins: [originPattern],
    }, resolve);
  });
}

function ModelDatalist({ id, models }) {
  return (
    <datalist id={id}>
      {models.map((model) => (
        <option key={model} value={model} />
      ))}
    </datalist>
  );
}

function ModelSuggestions({ models, selectedModel, onSelect }) {
  const visibleModels = models.slice(0, 8);

  if (!visibleModels.length) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {visibleModels.map((model) => (
        <button
          key={model}
          type="button"
          onClick={() => onSelect(model)}
          className={`rounded-md border px-2 py-1 text-xs font-semibold ${
            selectedModel === model
              ? "border-zinc-950 bg-zinc-950 text-white"
              : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-white"
          }`}
        >
          {model}
        </button>
      ))}
    </div>
  );
}

async function fetchProviderModels({ provider, apiKey, baseUrl }) {
  if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    const endpointBase = resolveOpenAiCompatibleBaseUrl(provider, baseUrl);
    const data = await fetchJsonWithApiError(`${endpointBase}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...openAiCompatibleExtraHeaders(provider),
      },
    }, provider);
    const modelIds = uniqueModelIds(data);

    return {
      chat: sortModels(modelIds.filter(isLikelyChatModel), provider),
      embedding: providerSupportsEmbeddings(provider)
        ? sortModels(modelIds.filter(isLikelyEmbeddingModel), provider)
        : [],
    };
  }

  if (provider === "gemini") {
    const data = await fetchJsonWithApiError(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
      {},
      provider,
    );
    const models = Array.isArray(data.models) ? data.models : [];

    return {
      chat: sortModels(
        models
          .filter((model) => supportsGeminiAction(model, "generateContent"))
          .map((model) => stripGeminiModelPrefix(model.name)),
        provider,
      ),
      embedding: sortModels(
        models
          .filter((model) => supportsGeminiAction(model, "embedContent"))
          .map((model) => stripGeminiModelPrefix(model.name)),
        provider,
      ),
    };
  }

  if (provider === "anthropic") {
    const data = await fetchJsonWithApiError("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    }, provider);

    return {
      chat: sortModels(uniqueModelIds(data), provider),
      embedding: [],
    };
  }

  throw new Error(`Model suggestions are not available for ${provider}.`);
}

async function fetchJsonWithApiError(url, options, provider) {
  const response = await fetch(url, {
    method: "GET",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const responseText = await response.text();

  if (!response.ok) {
    const parsedError = parseApiError(responseText);
    const error = new Error(parsedError.message || `Request failed with status ${response.status}.`);

    error.status = response.status;
    error.provider = provider;
    error.code = parsedError.code;
    error.type = parsedError.type;
    throw error;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return {};
  }
}

function uniqueModelIds(data) {
  const rawModels = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : [];
  const ids = rawModels
    .map((model) => String(model?.id || model?.name || model || "").trim())
    .map(stripGeminiModelPrefix)
    .filter(Boolean);

  return Array.from(new Set(ids));
}

function supportsGeminiAction(model, action) {
  const supportedActions = [
    ...(model.supportedGenerationMethods || []),
    ...(model.supportedActions || []),
    ...(model.supported_actions || []),
  ];

  return supportedActions.includes(action) || supportedActions.includes(`models.${action}`);
}

function isLikelyChatModel(modelId) {
  const model = modelId.toLowerCase();

  return !isLikelyEmbeddingModel(model) &&
    !/(audio|whisper|tts|image|vision|moderation|rerank|rank|transcribe|speech)/i.test(model);
}

function isLikelyEmbeddingModel(modelId) {
  return /(embed|embedding)/i.test(modelId);
}

function resolveOpenAiCompatibleBaseUrl(provider, baseUrl) {
  if (provider === "custom") {
    return baseUrl.replace(/\/+$/, "");
  }

  return PROVIDER_DEFAULTS[provider]?.baseUrl || "";
}

function openAiCompatibleExtraHeaders(provider) {
  if (provider === "openrouter") {
    return {
      "HTTP-Referer": "https://localhost",
      "X-OpenRouter-Title": "Verdict",
    };
  }

  return {};
}

function providerSupportsEmbeddings(provider) {
  const supportsEmbeddings = PROVIDER_DEFAULTS[provider]?.supportsEmbeddings;

  if (supportsEmbeddings === null) {
    return true;
  }

  return Boolean(supportsEmbeddings);
}

function sortModels(models, provider) {
  return Array.from(new Set(models.filter(Boolean))).sort((left, right) => (
    modelPreferenceScore(right, provider) - modelPreferenceScore(left, provider) ||
    left.localeCompare(right)
  ));
}

function modelPreferenceScore(modelId, provider) {
  const model = modelId.toLowerCase();
  let score = 0;

  if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    if (model.includes("gpt-4o-mini")) score += 100;
    if (model.includes("gpt-4o")) score += 80;
    if (model.includes("gpt-4.1-mini")) score += 70;
    if (model.includes("gpt-4.1")) score += 60;
    if (model.includes("text-embedding-3-small")) score += 100;
    if (model.includes("text-embedding-3-large")) score += 70;
  }

  if (provider === "groq") {
    if (model.includes("llama-3.3-70b-versatile")) score += 120;
    if (model.includes("llama")) score += 80;
    if (model.includes("instant")) score += 40;
  }

  if (provider === "openrouter") {
    if (model.includes("openai/")) score += 70;
    if (model.includes("anthropic/")) score += 60;
    if (model.includes("google/")) score += 50;
  }

  if (provider === "together") {
    if (model.includes("minimax")) score += 100;
    if (model.includes("llama")) score += 80;
    if (model.includes("embedding")) score += 80;
  }

  if (provider === "mistral") {
    if (model.includes("small")) score += 100;
    if (model.includes("mistral-embed")) score += 100;
    if (model.includes("latest")) score += 30;
  }

  if (provider === "deepseek" && model.includes("deepseek-chat")) score += 100;
  if (provider === "xai" && model.includes("grok")) score += 100;
  if (provider === "cerebras" && model.includes("llama")) score += 100;

  if (provider === "gemini") {
    if (model.includes("flash")) score += 100;
    if (model.includes("pro")) score += 50;
    if (model.includes("text-embedding")) score += 100;
  }

  if (provider === "anthropic") {
    if (model.includes("haiku")) score += 100;
    if (model.includes("sonnet")) score += 80;
    if (model.includes("opus")) score += 50;
  }

  if (/\blatest\b/i.test(model)) score += 20;
  if (/\bpreview\b/i.test(model)) score -= 20;

  return score;
}

function choosePreferredChatModel(models, provider) {
  return sortModels(models, provider)[0] || "";
}

function choosePreferredEmbeddingModel(models, provider) {
  return sortModels(models, provider)[0] || "";
}

function buildModelLookupSuccessMessage(suggestions) {
  const chatCount = suggestions.chat.length;
  const embeddingCount = suggestions.embedding.length;

  if (!chatCount && !embeddingCount) {
    return "The key worked, but no compatible chat or embedding models were found.";
  }

  if (embeddingCount) {
    return `Found ${chatCount} chat model${chatCount === 1 ? "" : "s"} and ${embeddingCount} embedding model${embeddingCount === 1 ? "" : "s"}.`;
  }

  return `Found ${chatCount} chat model${chatCount === 1 ? "" : "s"}. Embeddings will use the local browser model.`;
}

function formatModelLookupError(error, provider) {
  const status = Number(error?.status);
  const providerLabel = PROVIDER_LABELS[provider] || provider;
  const message = String(error?.message || "").replace(/\s+/g, " ").trim();

  if (status === 400 || status === 401 || status === 403) {
    return `${providerLabel} rejected this API key. Check that the selected provider matches the key, the key is active, and any key restrictions allow browser/API access. ${message}`;
  }

  if (status === 404) {
    return `${providerLabel} did not expose a model-list endpoint at this URL. Check the base URL or enter the model manually.`;
  }

  if (/failed to fetch/i.test(message)) {
    return `Could not reach ${providerLabel}. Check internet access, provider permissions, or CORS support for this API.`;
  }

  return message || "Could not fetch models for this provider.";
}

function parseApiError(responseText) {
  try {
    const parsed = JSON.parse(responseText);
    const error = parsed.error || parsed;

    return {
      message: error.message || parsed.message || responseText,
      code: error.code || parsed.code || "",
      type: error.type || parsed.type || "",
    };
  } catch {
    return {
      message: responseText,
      code: "",
      type: "",
    };
  }
}

function stripGeminiModelPrefix(modelName) {
  return String(modelName || "").replace(/^models\//, "");
}

function detectProviderFromKey(apiKey) {
  const key = String(apiKey || "").trim();

  if (/^gsk_/i.test(key)) {
    return "groq";
  }

  if (/^sk-or-/i.test(key)) {
    return "openrouter";
  }

  if (/^sk-ant-/i.test(key)) {
    return "anthropic";
  }

  if (/^AIza/i.test(key)) {
    return "gemini";
  }

  if (/^sk-/i.test(key)) {
    return "openai";
  }

  return "";
}

function providersAreCompatible(detectedProvider, selectedProvider) {
  if (detectedProvider === selectedProvider) {
    return true;
  }

  return detectedProvider === "openai" && OPENAI_COMPATIBLE_PROVIDERS.has(selectedProvider);
}

const container = document.getElementById("root");

if (window.location.pathname.endsWith("options.html")) {
  const root = createRoot(container);
  root.render(<SettingsPanel />);
}
