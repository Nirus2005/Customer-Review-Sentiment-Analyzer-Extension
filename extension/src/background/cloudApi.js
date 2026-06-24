const DEFAULT_MAX_OUTPUT_TOKENS = 600;
const SENTIMENT_LABELS = new Set(["POSITIVE", "NEGATIVE", "MIXED"]);
const TOKEN_LIMIT_PATTERNS = [
  /context[_\s-]?length[_\s-]?exceeded/i,
  /context window/i,
  /context.*exceed/i,
  /exceed.*context/i,
  /input.*token/i,
  /prompt.*too long/i,
  /request.*too large/i,
  /payload too large/i,
  /too many tokens/i,
  /token.*limit/i,
  /maximum.*tokens/i,
  /reduce.*tokens/i,
];

const OPENAI_COMPATIBLE_PROVIDER_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
  cerebras: "https://api.cerebras.ai/v1",
};

export async function generateWithCloudApi({
  messages,
  port,
  requestId,
  provider,
  apiKey,
  modelName,
  baseUrl,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}) {
  const request = buildGenerationRequest({
    messages,
    provider,
    apiKey,
    modelName,
    baseUrl,
    maxOutputTokens,
  });
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });

  if (!response.ok) {
    throw await buildApiError(response, `${provider} chat request failed`);
  }

  await streamProviderResponse({
    response,
    provider,
    port,
    requestId,
  });
}

export async function embedWithCloudApi(texts, provider, apiKey, baseUrl, embeddingModelName) {
  const request = buildEmbeddingRequest({
    texts,
    provider,
    apiKey,
    baseUrl,
    embeddingModelName,
  });
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });

  if (!response.ok) {
    throw await buildApiError(response, `${provider} embedding request failed`);
  }

  const data = await response.json();

  if (normalizeProvider(provider) === "gemini") {
    return (data.embeddings || []).map((embedding) => embedding.values || []);
  }

  return (data.data || []).map((item) => item.embedding || []);
}

export async function classifySentimentWithCloudApi(texts, provider, apiKey, modelName, baseUrl) {
  const promptText = (
    "Classify the sentiment of each text. Reply with only a valid JSON array of strings. " +
    'Each string must be exactly "Positive", "Negative", or "Mixed". ' +
    `Return exactly ${texts.length} strings in the same order.\n\nTexts:\n${JSON.stringify(texts)}`
  );
  const messages = [
    {
      role: "user",
      content: promptText,
    },
  ];
  const request = buildCompletionRequest({
    messages,
    provider,
    apiKey,
    modelName,
    baseUrl,
    maxOutputTokens: Math.min(1200, Math.max(160, texts.length * 12 + 80)),
  });
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });

  if (!response.ok) {
    throw await buildApiError(response, `${provider} sentiment request failed`);
  }

  const data = await response.json();
  const resultText = extractCompletionText(data, provider);
  const labels = parseSentimentLabels(resultText, texts.length);

  return labels.map((label) => ({
    label,
    score: label === "MIXED" ? 0.68 : 0.99,
  }));
}

export function isTokenLimitExceededError(error) {
  if (!error) {
    return false;
  }

  const status = Number(error.status);
  const searchableText = [
    error.message,
    error.responseText,
    error.code,
    error.type,
  ]
    .filter(Boolean)
    .join(" ");

  return status === 413 || TOKEN_LIMIT_PATTERNS.some((pattern) => pattern.test(searchableText));
}

function buildGenerationRequest(options) {
  return buildCompletionRequest({
    ...options,
    stream: true,
  });
}

function buildCompletionRequest({
  messages,
  provider,
  apiKey,
  modelName,
  baseUrl,
  maxOutputTokens,
  stream = false,
}) {
  const normalizedProvider = normalizeProvider(provider);
  const fullPromptText = flattenMessages(messages);

  if (normalizedProvider === "gemini") {
    const geminiModel = stripGeminiModelPrefix(modelName);

    return {
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:${stream ? "streamGenerateContent" : "generateContent"}?key=${encodeURIComponent(apiKey)}`,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        contents: [
          {
            role: "user",
            parts: [{ text: fullPromptText }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens,
        },
      },
    };
  }

  if (normalizedProvider === "anthropic") {
    return {
      endpoint: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: {
        model: modelName,
        max_tokens: maxOutputTokens,
        temperature: 0,
        system: messages.find((message) => message.role === "system")?.content || "",
        messages: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: String(message.content || ""),
          })),
        stream,
      },
    };
  }

  if (isOpenAiCompatibleProvider(normalizedProvider)) {
    const endpointBase = resolveOpenAiCompatibleBaseUrl(normalizedProvider, baseUrl);

    return {
      endpoint: `${endpointBase}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...openAiCompatibleExtraHeaders(normalizedProvider),
      },
      body: {
        model: modelName,
        messages,
        temperature: 0,
        max_tokens: maxOutputTokens,
        stream,
      },
    };
  }

  throw new Error(`Unsupported AI provider: ${provider}`);
}

function buildEmbeddingRequest({
  texts,
  provider,
  apiKey,
  baseUrl,
  embeddingModelName,
}) {
  const normalizedProvider = normalizeProvider(provider);

  if (normalizedProvider === "gemini") {
    const model = stripGeminiModelPrefix(embeddingModelName || "text-embedding-004");

    return {
      endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      },
    };
  }

  if (isOpenAiCompatibleProvider(normalizedProvider)) {
    const endpointBase = resolveOpenAiCompatibleBaseUrl(normalizedProvider, baseUrl);

    return {
      endpoint: `${endpointBase}/embeddings`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...openAiCompatibleExtraHeaders(normalizedProvider),
      },
      body: {
        model: embeddingModelName || "text-embedding-3-small",
        input: texts,
      },
    };
  }

  throw new Error(`${provider} does not provide a supported embedding API.`);
}

async function streamProviderResponse({
  response,
  provider,
  port,
  requestId,
}) {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("Cloud provider did not return a readable response stream.");
  }

  const decoder = new TextDecoder("utf-8");
  let accumulatedText = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    const newText = extractStreamText(chunk, provider);

    if (!newText) {
      continue;
    }

    accumulatedText += newText;

    if (!safePostMessage(port, {
      type: "TOKEN",
      requestId,
      token: newText,
      text: accumulatedText,
    })) {
      return;
    }
  }

  safePostMessage(port, {
    type: "DONE",
    requestId,
    text: accumulatedText,
  });
}

function extractStreamText(chunk, provider) {
  if (normalizeProvider(provider) === "gemini") {
    return extractGeminiText(chunk);
  }

  let text = "";
  const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const dataText = line.slice(6).trim();

    if (!dataText || dataText === "[DONE]") {
      continue;
    }

    try {
      const data = JSON.parse(dataText);
      text += (
        data.choices?.[0]?.delta?.content ||
        data.delta?.text ||
        ""
      );
    } catch {
      // Streaming chunks can be split in the middle of a JSON object.
    }
  }

  return text;
}

function extractGeminiText(chunk) {
  let text = "";
  const matches = chunk.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g);

  for (const match of matches) {
    try {
      text += JSON.parse(`"${match[1]}"`);
    } catch {
      text += match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  }

  return text;
}

function extractCompletionText(data, provider) {
  const normalizedProvider = normalizeProvider(provider);

  if (normalizedProvider === "gemini") {
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  }

  if (normalizedProvider === "anthropic") {
    return data.content?.map((part) => part.text || "").join("") || "";
  }

  return data.choices?.[0]?.message?.content || "";
}

function parseSentimentLabels(resultText, expectedLength) {
  const cleanedText = String(resultText || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleanedText);

    if (Array.isArray(parsed) && parsed.length === expectedLength) {
      return parsed.map(normalizeSentimentLabel);
    }
  } catch {
    // Fall through to the conservative fallback below.
  }

  return Array.from({ length: expectedLength }, () => "MIXED");
}

function normalizeSentimentLabel(label) {
  const normalized = String(label || "").trim().toUpperCase();

  if (SENTIMENT_LABELS.has(normalized)) {
    return normalized;
  }

  if (normalized.includes("NEG")) {
    return "NEGATIVE";
  }

  if (normalized.includes("POS")) {
    return "POSITIVE";
  }

  return "MIXED";
}

async function buildApiError(response, fallbackMessage) {
  const responseText = await response.text().catch(() => "");
  const parsedError = parseErrorBody(responseText);
  const message = parsedError.message || responseText || fallbackMessage;
  const error = new Error(`API Error ${response.status}: ${truncateText(message, 700)}`);

  error.status = response.status;
  error.responseText = responseText;
  error.code = parsedError.code;
  error.type = parsedError.type;

  return error;
}

function parseErrorBody(responseText) {
  try {
    const parsed = JSON.parse(responseText);
    const error = parsed.error || parsed;

    return {
      message: error.message || parsed.message || "",
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

function flattenMessages(messages) {
  return messages
    .map((message) => `${message.role === "system" ? "System" : "User"}: ${message.content || ""}`)
    .join("\n\n");
}

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

function isOpenAiCompatibleProvider(provider) {
  return provider === "custom" || Object.hasOwn(OPENAI_COMPATIBLE_PROVIDER_BASE_URLS, provider);
}

function resolveOpenAiCompatibleBaseUrl(provider, baseUrl) {
  if (provider === "custom") {
    return normalizeBaseUrl(baseUrl);
  }

  return OPENAI_COMPATIBLE_PROVIDER_BASE_URLS[provider];
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

function stripGeminiModelPrefix(modelName) {
  return String(modelName || "").replace(/^models\//, "");
}

function normalizeBaseUrl(baseUrl) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");

  if (!normalizedBaseUrl) {
    throw new Error("Base URL is required for a custom OpenAI-compatible provider.");
  }

  return normalizedBaseUrl;
}

function truncateText(text, maxLength) {
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();

  return cleanText.length > maxLength
    ? `${cleanText.slice(0, maxLength)}...`
    : cleanText;
}

function safePostMessage(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}
