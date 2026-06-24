import {
  MESSAGE_TYPES,
  PORT_NAMES,
  RAG_LIMITS,
} from "../constants/ragConfig.js";
import {
  cleanStreamingAnswer,
  isDegenerateGeneratedText,
} from "../localRag/responseGuards.js";

export async function classifyTextsLocally(texts, reportProgress = () => {}, signal, progressOptions = {}) {
  const results = [];

  await runInBatches(texts, RAG_LIMITS.sentimentBatchSize, async (batch, completed, total) => {
    reportProgress({
      stage: progressOptions.stage || "classifying",
      message: `Analyzing review sentiment (${completed}/${total})...`,
      current: completed,
      total,
    });
    const response = await sendWorkerMessage({
      type: MESSAGE_TYPES.CLASSIFY_SENTIMENT,
      texts: batch,
    });

    if (response.fallbackReason) {
      reportProgress({
        stage: progressOptions.stage || "classifying",
        message: response.fallbackReason,
        current: completed,
        total,
      });
    }

    results.push(...(response.results || []));
  }, signal);

  return results;
}

export async function embedTextsLocally(texts, reportProgress = () => {}, signal, progressOptions = {}) {
  const embeddings = [];

  await runInBatches(texts, RAG_LIMITS.embeddingBatchSize, async (batch, completed, total) => {
    reportProgress({
      stage: progressOptions.stage || "indexing",
      message: `Building searchable review index (${completed}/${total})...`,
      current: completed,
      total,
    });
    const response = await sendWorkerMessage({
      type: MESSAGE_TYPES.EMBED_TEXTS,
      texts: batch,
    });

    if (response.fallbackReason) {
      reportProgress({
        stage: progressOptions.stage || "indexing",
        message: response.fallbackReason,
        current: completed,
        total,
      });
    }

    embeddings.push(...(response.embeddings || []));
  }, signal);

  return embeddings;
}

export function streamLocalGeneration({
  query,
  context,
  recentChat,
  conversationSummary,
  sessionAnalytics,
  answerStyle,
  maxNewTokens,
  signal,
  onToken,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const requestId = makeMessageId();
    const port = chrome.runtime.connect({
      name: PORT_NAMES.GENERATION,
    });
    let finalText = "";
    let displayedText = "";
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      finish(() => reject(new Error("Local generation timed out.")));
    }, RAG_LIMITS.generationTimeoutMs);
    const cancelActiveGeneration = () => {
      try {
        port.postMessage({
          type: MESSAGE_TYPES.CANCEL_GENERATION,
          requestId,
        });
      } catch {
        // The port may already be closed by Chrome.
      }
    };
    const abortHandler = () => {
      cancelActiveGeneration();
      finish(() => reject(abortError()));
    };

    signal?.addEventListener("abort", abortHandler, {
      once: true,
    });

    function finish(callback) {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);

      try {
        port.disconnect();
      } catch {
        // The port may already be closed by Chrome.
      }

      callback();
    }

    port.onMessage.addListener((message) => {
      if (message.requestId && message.requestId !== requestId) {
        return;
      }

      if (message.type === "TOKEN") {
        finalText = textFromPortValue(message.text) || `${finalText}${textFromPortValue(message.token)}`;

        if (isDegenerateGeneratedText(finalText)) {
          cancelActiveGeneration();
          finish(() => reject(new Error("Local generator produced repetitive text.")));
          return;
        }

        const safeDisplayText = cleanStreamingAnswer(finalText);

        if (onToken && safeDisplayText && safeDisplayText !== displayedText) {
          displayedText = safeDisplayText;
          onToken(safeDisplayText);
        }

        return;
      }

      if (message.type === "DONE") {
        finalText = textFromPortValue(message.text) || finalText;
        finish(() => resolve(finalText));
        return;
      }

      if (message.type === "ERROR") {
        finish(() => reject(new Error(message.error || "Local generation failed.")));
        return;
      }

      if (message.type === "CANCELLED") {
        finish(() => reject(abortError()));
      }
    });

    port.onDisconnect.addListener(() => {
      if (!settled) {
        finish(() => reject(new Error(chrome.runtime.lastError?.message || "Local generation worker disconnected.")));
      }
    });

    port.postMessage({
      type: MESSAGE_TYPES.GENERATE,
      requestId,
      query,
      context,
      recentChat,
      conversationSummary,
      sessionAnalytics,
      answerStyle,
      maxNewTokens,
    });
  });
}

export function sendWorkerMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "Local worker request failed."));
        return;
      }

      resolve(response);
    });
  });
}

export function makeMessageId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

export function abortError() {
  const error = new Error("Generation stopped.");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error) {
  return error?.name === "AbortError";
}

async function runInBatches(items, batchSize, worker, signal) {
  for (let index = 0; index < items.length; index += batchSize) {
    throwIfAborted(signal);
    const batch = items.slice(index, index + batchSize);
    await worker(batch, Math.min(index + batch.length, items.length), items.length);
    throwIfAborted(signal);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function textFromPortValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const assistantMessage = [...value].reverse().find((item) => (
      String(item?.role || "").toLowerCase() === "assistant" &&
      item.content !== undefined
    ));

    if (assistantMessage) {
      return textFromPortValue(assistantMessage.content);
    }

    return value.map(textFromPortValue).filter(Boolean).join("");
  }

  if (typeof value === "object") {
    if (value.generated_text !== undefined) return textFromPortValue(value.generated_text);
    if (value.message !== undefined) return textFromPortValue(value.message);
    if (value.content !== undefined) return textFromPortValue(value.content);
    if (value.text !== undefined) return textFromPortValue(value.text);
    if (value.token !== undefined) return textFromPortValue(value.token);
    if (value.token_text !== undefined) return textFromPortValue(value.token_text);
    if (value.output_text !== undefined) return textFromPortValue(value.output_text);
  }

  return "";
}
