const DB_NAME = "review-rag-local-store";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const CHUNK_STORE = "chunks";
const SESSION_INDEX = "sessionId";

export async function saveLocalSession(session, chunks) {
  const db = await openLocalRagDb();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
    const sessions = transaction.objectStore(SESSION_STORE);
    const chunkStore = transaction.objectStore(CHUNK_STORE);

    sessions.put(stripSessionChunks(session));
    chunks.forEach((chunk) => chunkStore.put(chunk));

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function updateLocalSession(session) {
  const db = await openLocalRagDb();

  await writeToStore(db, SESSION_STORE, stripSessionChunks(session));
}

export async function appendLocalSessionChunks(chunks) {
  const db = await openLocalRagDb();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(CHUNK_STORE, "readwrite");
    const store = transaction.objectStore(CHUNK_STORE);

    chunks.forEach((chunk) => store.put(chunk));

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getLocalSession(sessionId) {
  const db = await openLocalRagDb();
  return readFromStore(db, SESSION_STORE, sessionId);
}

export async function getLocalSessionChunks(sessionId) {
  const db = await openLocalRagDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHUNK_STORE, "readonly");
    const store = transaction.objectStore(CHUNK_STORE);
    const index = store.index(SESSION_INDEX);
    const request = index.getAll(sessionId);

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteLocalSession(sessionId) {
  const db = await openLocalRagDb();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
    const sessions = transaction.objectStore(SESSION_STORE);
    const chunks = transaction.objectStore(CHUNK_STORE);
    const chunkIndex = chunks.index(SESSION_INDEX);

    sessions.delete(sessionId);

    const cursorRequest = chunkIndex.openCursor(IDBKeyRange.only(sessionId));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;

      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function openLocalRagDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, {
          keyPath: "id",
        });
      }

      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const chunkStore = db.createObjectStore(CHUNK_STORE, {
          keyPath: "id",
        });

        chunkStore.createIndex(SESSION_INDEX, "sessionId", {
          unique: false,
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readFromStore(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const store = transaction.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result || null);
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

function stripSessionChunks(session) {
  const { chunks: _chunks, ...storedSession } = session;
  return storedSession;
}
