import {
  MESSAGE_TYPES,
  PORT_NAMES,
  SELECTION_LAUNCH_STORAGE_KEY,
} from "./constants/ragConfig.js";
import {
  classifySentiment,
  configureTransformersEnvironment,
  embedTexts,
  getModelStatus,
  initModels,
  markExtensionInstalled,
  cancelGeneration,
  streamGenerationToPort,
} from "./background/modelRuntime.js";

configureTransformersEnvironment();

chrome.runtime.onInstalled.addListener(() => {
  markExtensionInstalled().catch(console.warn);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
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
    if (message?.type === MESSAGE_TYPES.CANCEL_GENERATION) {
      const cancelled = cancelGeneration(message.requestId);
      safePostMessage(port, {
        type: "CANCELLED",
        requestId: message.requestId,
        cancelled,
      });
      return;
    }

    if (message?.type === MESSAGE_TYPES.GENERATE) {
      streamGenerationToPort(port, message).catch((error) => {
        safePostMessage(port, {
          type: "ERROR",
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    safePostMessage(port, {
      type: "ERROR",
      requestId: message?.requestId,
      error: `Unknown port message type: ${message?.type || "missing"}`,
    });
  });
});

function safePostMessage(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The popup may have closed or cancelled the port.
  }
}

async function handleRuntimeMessage(message, sender) {
  switch (message?.type) {
    case MESSAGE_TYPES.OPEN_POPUP_FOR_SELECTION:
      return openPopupForSelection(sender, message);

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

async function openPopupForSelection(sender, message) {
  const rememberLaunch = rememberSelectionLaunch(sender, message);

  if (!chrome.action?.openPopup) {
    await rememberLaunch.catch(() => {});
    return {
      ok: false,
      error: "Open Verdict from the toolbar",
    };
  }

  try {
    const openPopup = chrome.action.openPopup();

    await Promise.all([
      rememberLaunch,
      openPopup,
    ]);
    return {
      ok: true,
      opened: "popup",
    };
  } catch {
    await rememberLaunch.catch(() => {});
    return {
      ok: false,
      error: "Open Verdict from the toolbar",
    };
  }
}

async function rememberSelectionLaunch(sender, message) {
  const storageArea = chrome.storage.session || chrome.storage.local;
  const launch = {
    source: "selection-button",
    tabId: sender?.tab?.id ?? null,
    windowId: sender?.tab?.windowId ?? null,
    pageUrl: sender?.tab?.url || "",
    createdAt: Date.now(),
    selectionScrapeResult: normalizeSelectionScrapeResult(message?.selectionScrapeResult),
  };

  await storageSet(storageArea, {
    [SELECTION_LAUNCH_STORAGE_KEY]: launch,
  });
}

function normalizeSelectionScrapeResult(result) {
  if (!result || typeof result !== "object") {
    return null;
  }

  return {
    reviews: Array.isArray(result.reviews) ? result.reviews : [],
    hitLimit: Boolean(result.hitLimit),
    selectionFound: Boolean(result.selectionFound || result.usedSelection),
    usedSelection: Boolean(result.selectionFound || result.usedSelection),
    error: typeof result.error === "string" ? result.error : "",
  };
}

function storageSet(storageArea, values) {
  return new Promise((resolve, reject) => {
    storageArea.set(values, () => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}
