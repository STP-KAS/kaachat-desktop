// IndexedDB-backed persistence for the desktop chat state.
//
// Conversations/messages used to live in localStorage, whose ~5MB origin quota
// a single large phone-backup import can exceed (forcing message trimming).
// This module moves those keys into IndexedDB — database "kachat-desktop",
// a single "kv" object store keyed by the exact same account-scoped key
// strings app.js already uses — while keeping the app's READ path fully
// synchronous:
//
//   * initChatStorage() opens the database once at startup and warms an
//     in-memory Map with every stored entry (all accounts). It also performs a
//     one-time migration: chat-state keys still sitting in localStorage are
//     copied into IndexedDB and then REMOVED from localStorage, freeing the
//     quota for everything that stays there (settings, caches, dock prefs…).
//   * chatStorageGetSync() reads from that cache — no async plumbing anywhere
//     in the app's state-restore paths.
//   * chatStorageSetSync() updates the cache immediately and schedules a
//     debounced (300ms) fire-and-forget IndexedDB write; concurrent writes to
//     the same key coalesce so only the latest snapshot is flushed.
//   * flushChatStorage() force-starts any pending write immediately —
//     called from beforeunload/visibilitychange as a best-effort final save.
//
// If IndexedDB is unavailable (Safari private mode, disabled storage, open
// timeout), the module degrades to plain localStorage passthrough — including
// the original synchronous QuotaExceededError, which app.js's legacy
// quota-aware persistState() fallback still handles.

const DB_NAME = "kachat-desktop";
const DB_VERSION = 1;
const STORE_NAME = "kv";
const FLUSH_DEBOUNCE_MS = 300;
const OPEN_TIMEOUT_MS = 5000;

const DELETE_SENTINEL = Symbol("kachat-storage-delete");

let db = null;
let durable = false; // true once IndexedDB is open and the cache is warmed
const cache = new Map(); // key -> stored value (mirror of the kv store)
const pendingWrites = new Map(); // key -> value | DELETE_SENTINEL
let flushTimer = null;
let flushErrorHandler = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"));
  });
}

function openDatabaseWithTimeout(ms) {
  return Promise.race([
    openDatabase(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("IndexedDB open timed out")), ms)),
  ]);
}

function readAllEntries(database) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const keysRequest = store.getAllKeys();
    const valuesRequest = store.getAll();
    tx.oncomplete = () => {
      const keys = keysRequest.result || [];
      const values = valuesRequest.result || [];
      const entries = new Map();
      for (let i = 0; i < keys.length; i += 1) entries.set(String(keys[i]), values[i]);
      resolve(entries);
    };
    tx.onerror = () => reject(tx.error || new Error("IndexedDB read failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB read aborted"));
  });
}

function writeEntries(database, entries) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = database.transaction(STORE_NAME, "readwrite");
    } catch (error) {
      reject(error);
      return;
    }
    const store = tx.objectStore(STORE_NAME);
    for (const [key, value] of entries) {
      if (value === DELETE_SENTINEL) store.delete(key);
      else store.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted"));
  });
}

/**
 * Open the database, warm the in-memory cache with every stored entry, and
 * migrate any localStorage keys matched by `shouldMigrateKey` into IndexedDB
 * (deleting them from localStorage afterwards — this is what frees the quota).
 * When both stores hold the same key, the IndexedDB copy wins (localStorage
 * can only contain a stale pre-migration copy at that point) and the stale
 * localStorage copy is still removed.
 *
 * Returns { durable } — false means IndexedDB is unusable and every
 * chatStorage*Sync call passes straight through to localStorage.
 */
export async function initChatStorage({ shouldMigrateKey = () => false, log = () => {} } = {}) {
  if (durable) return { durable };
  try {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available");
    db = await openDatabaseWithTimeout(OPEN_TIMEOUT_MS);
    const stored = await readAllEntries(db);
    for (const [key, value] of stored) cache.set(key, value);

    // One-time migration of matching localStorage keys.
    const migratable = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && shouldMigrateKey(key)) migratable.push(key);
      }
    } catch { /* localStorage itself unavailable — nothing to migrate */ }

    const toWrite = new Map();
    for (const key of migratable) {
      if (cache.has(key)) continue; // IndexedDB already owns this key
      const value = localStorage.getItem(key);
      if (value === null) continue;
      cache.set(key, value);
      toWrite.set(key, value);
    }
    if (toWrite.size > 0) {
      await writeEntries(db, toWrite); // awaited: only delete after a confirmed write
      log(`Migrated ${toWrite.size} chat-state key(s) from localStorage into IndexedDB.`);
    }
    for (const key of migratable) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }

    durable = true;
    db.onversionchange = () => { try { db.close(); } catch { /* ignore */ } };
  } catch (error) {
    db = null;
    durable = false;
    log(`IndexedDB unavailable (${error?.message || error}) — chat state stays in localStorage.`);
  }
  return { durable };
}

/** True when IndexedDB is the active store; false means localStorage passthrough. */
export function isChatStorageDurable() {
  return durable;
}

/** Called (with the Error) whenever a debounced IndexedDB flush fails. */
export function setChatStorageFlushErrorHandler(handler) {
  flushErrorHandler = typeof handler === "function" ? handler : null;
}

/** Synchronous read: warmed cache in IndexedDB mode, localStorage otherwise. */
export function chatStorageGetSync(key) {
  if (!durable) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  return cache.has(key) ? cache.get(key) : null;
}

/**
 * Synchronous write: cache is updated immediately (reads see it right away),
 * the IndexedDB write happens on a 300ms debounce. In localStorage-fallback
 * mode this writes synchronously and CAN throw QuotaExceededError — callers
 * (persistState) keep their legacy quota handling for exactly that case.
 */
export function chatStorageSetSync(key, value) {
  if (!durable) {
    localStorage.setItem(key, value);
    return;
  }
  cache.set(key, value);
  pendingWrites.set(key, value);
  scheduleFlush();
}

export function chatStorageRemoveSync(key) {
  if (!durable) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return;
  }
  cache.delete(key);
  pendingWrites.set(key, DELETE_SENTINEL);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPendingWrites();
  }, FLUSH_DEBOUNCE_MS);
}

/**
 * Start any pending IndexedDB write immediately (cancelling the debounce).
 * Safe to call from beforeunload: the transaction is opened synchronously, so
 * the browser will usually let it complete even as the page tears down.
 */
export function flushChatStorage() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return flushPendingWrites();
}

function flushPendingWrites() {
  if (!durable || pendingWrites.size === 0) return Promise.resolve();
  const batch = new Map(pendingWrites);
  pendingWrites.clear();
  return writeEntries(db, batch).catch((error) => {
    // Re-queue what failed so the next flush retries it — unless a newer write
    // for the same key superseded it in the meantime.
    for (const [key, value] of batch) {
      if (!pendingWrites.has(key)) pendingWrites.set(key, value);
    }
    try { flushErrorHandler?.(error); } catch { /* handler must not break flushing */ }
  });
}

// ---------------------------------------------------------------------------
// Low-level async API (kv store of JSON-serializable values). The app itself
// uses the synchronous cache facade above; these are the primitives for code
// that can await (and they keep the cache coherent when IndexedDB is active).
// ---------------------------------------------------------------------------

export async function storageGet(key) {
  if (!durable) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result === undefined ? null : request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB get failed"));
  });
}

export async function storageSet(key, value) {
  if (!durable) {
    localStorage.setItem(key, value);
    return;
  }
  cache.set(key, value);
  await writeEntries(db, new Map([[key, value]]));
}

export async function storageDelete(key) {
  if (!durable) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return;
  }
  cache.delete(key);
  await writeEntries(db, new Map([[key, DELETE_SENTINEL]]));
}
