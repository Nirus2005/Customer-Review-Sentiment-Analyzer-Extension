export const AI_KEY_STORAGE_MODES = Object.freeze({
  LOCAL: "local",
  SESSION: "session",
});

const AI_SETTING_KEYS = [
  "aiProvider",
  "aiApiKey",
  "aiBaseUrl",
  "aiModelName",
  "aiEmbeddingModelName",
  "aiLastFallbackAt",
  "aiLastFallbackReason",
  "aiKeyStorageMode",
];

const LOCAL_PUBLIC_AI_SETTING_KEYS = [
  "aiProvider",
  "aiBaseUrl",
  "aiModelName",
  "aiEmbeddingModelName",
  "aiLastFallbackReason",
  "aiKeyStorageMode",
];

export async function getEffectiveAiSettings() {
  const localSettings = await storageGetMany(chrome.storage.local, AI_SETTING_KEYS);
  const sessionSettings = await getSessionAiSettings();
  const hasSessionSettings = Boolean(sessionSettings.aiApiKey);
  const mergedSettings = hasSessionSettings
    ? {
      ...localSettings,
      ...sessionSettings,
    }
    : localSettings;
  const storageMode = hasSessionSettings ||
    mergedSettings.aiKeyStorageMode === AI_KEY_STORAGE_MODES.SESSION
    ? AI_KEY_STORAGE_MODES.SESSION
    : AI_KEY_STORAGE_MODES.LOCAL;

  return normalizeAiSettings({
    ...mergedSettings,
    aiKeyStorageMode: storageMode,
    aiSettingsSource: hasSessionSettings ? AI_KEY_STORAGE_MODES.SESSION : AI_KEY_STORAGE_MODES.LOCAL,
  });
}

export async function saveAiSettings(settings) {
  const normalizedSettings = normalizeAiSettings(settings);
  const hasCloudKey = normalizedSettings.aiProvider !== "local" && normalizedSettings.aiApiKey;
  const storageMode = hasCloudKey
    ? normalizedSettings.aiKeyStorageMode
    : AI_KEY_STORAGE_MODES.LOCAL;

  if (storageMode === AI_KEY_STORAGE_MODES.SESSION && !chrome.storage.session) {
    throw new Error("Session-only API key storage is not available in this browser.");
  }

  const storedSettings = {
    aiProvider: normalizedSettings.aiProvider,
    aiApiKey: normalizedSettings.aiApiKey,
    aiBaseUrl: normalizedSettings.aiBaseUrl,
    aiModelName: normalizedSettings.aiModelName,
    aiEmbeddingModelName: normalizedSettings.aiEmbeddingModelName,
    aiLastFallbackReason: "",
    aiKeyStorageMode: storageMode,
  };

  if (storageMode === AI_KEY_STORAGE_MODES.LOCAL) {
    await storageSet(chrome.storage.local, storedSettings);
    await removeSessionAiSettings();
    return;
  }

  await storageSet(chrome.storage.local, pickKeys(storedSettings, LOCAL_PUBLIC_AI_SETTING_KEYS));
  await storageRemove(chrome.storage.local, ["aiApiKey"]);
  await storageSet(chrome.storage.session, storedSettings);
}

export async function removeSavedAiKey() {
  await removeSessionAiSettings();
  await storageRemove(chrome.storage.local, ["aiApiKey"]);
  await storageSet(chrome.storage.local, {
    aiKeyStorageMode: AI_KEY_STORAGE_MODES.LOCAL,
    aiLastFallbackReason: "",
  });
}

export async function switchAiSettingsToLocal(fallbackReason) {
  await removeSessionAiSettings();
  await storageSet(chrome.storage.local, {
    aiProvider: "local",
    aiKeyStorageMode: AI_KEY_STORAGE_MODES.LOCAL,
    aiLastFallbackAt: new Date().toISOString(),
    aiLastFallbackReason: fallbackReason,
  });
}

export function maskApiKey(apiKey) {
  const cleanKey = String(apiKey || "").trim();

  if (!cleanKey) {
    return "";
  }

  if (cleanKey.length <= 8) {
    return `${cleanKey.slice(0, 2)}...${cleanKey.slice(-2)}`;
  }

  const knownPrefix = [
    "sk-ant-",
    "sk-or-",
    "gsk_",
    "AIza",
    "sk-",
  ].find((prefix) => cleanKey.startsWith(prefix));
  const prefix = knownPrefix || `${cleanKey.slice(0, 3)}-`;

  return `${prefix}...${cleanKey.slice(-4)}`;
}

function normalizeAiSettings(settings) {
  const storageMode = settings.aiKeyStorageMode === AI_KEY_STORAGE_MODES.SESSION
    ? AI_KEY_STORAGE_MODES.SESSION
    : AI_KEY_STORAGE_MODES.LOCAL;

  return {
    aiProvider: String(settings.aiProvider || "local").trim() || "local",
    aiApiKey: String(settings.aiApiKey || "").trim(),
    aiBaseUrl: String(settings.aiBaseUrl || "").trim().replace(/\/+$/, ""),
    aiModelName: String(settings.aiModelName || "").trim(),
    aiEmbeddingModelName: String(settings.aiEmbeddingModelName || "").trim(),
    aiLastFallbackAt: String(settings.aiLastFallbackAt || ""),
    aiLastFallbackReason: String(settings.aiLastFallbackReason || ""),
    aiKeyStorageMode: storageMode,
    aiSettingsSource: settings.aiSettingsSource === AI_KEY_STORAGE_MODES.SESSION
      ? AI_KEY_STORAGE_MODES.SESSION
      : AI_KEY_STORAGE_MODES.LOCAL,
  };
}

async function getSessionAiSettings() {
  if (!chrome.storage.session) {
    return {};
  }

  return storageGetMany(chrome.storage.session, AI_SETTING_KEYS);
}

async function removeSessionAiSettings() {
  if (!chrome.storage.session) {
    return;
  }

  await storageRemove(chrome.storage.session, AI_SETTING_KEYS);
}

function pickKeys(source, keys) {
  return keys.reduce((picked, key) => {
    picked[key] = source[key];
    return picked;
  }, {});
}

function storageGetMany(storageArea, keys) {
  return new Promise((resolve, reject) => {
    storageArea.get(keys, (result) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(result || {});
    });
  });
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

function storageRemove(storageArea, keys) {
  return new Promise((resolve, reject) => {
    storageArea.remove(keys, () => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve();
    });
  });
}
