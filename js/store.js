const SAVED_KEY = 'kesach.saved';
const PROG_KEY = 'kesach.progress';
const PREF_KEY = 'kesach.prefs';
const TS_KEY = 'kesach.updatedAt';
const REMOVED_PROG_KEY = 'kesach.removedProgress';
const CACHE_NAME = 'kesach-archive-v1';

let syncTimer = null;
let dirtyForBeacon = false;

function hasStorage() {
  return typeof localStorage !== 'undefined';
}

function readJson(key, fallback) {
  if (!hasStorage()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, val, touchTs = true) {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(key, JSON.stringify(val));
    if (touchTs) {
      localStorage.setItem(TS_KEY, String(Date.now()));
    }
  } catch {
    // Ignore storage quota errors
  }
}

function snapshotAll() {
  const saved = getSaved();
  const rem = readJson(REMOVED_PROG_KEY, []);
  return {
    saved,
    clearSaved: saved.length === 0,
    progress: readJson(PROG_KEY, {}),
    removedProgress: Array.isArray(rem) ? rem : [],
    prefs: readJson(PREF_KEY, {})
  };
}

function scheduleServerSync() {
  if (typeof window === 'undefined') return;
  dirtyForBeacon = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/userdata', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshotAll())
      });
      if (res.ok) {
        const out = await res.json();
        dirtyForBeacon = false;
        writeJson(REMOVED_PROG_KEY, [], false);
        if (out && out.updatedAt && hasStorage()) {
          localStorage.setItem(TS_KEY, String(out.updatedAt));
        }
      }
    } catch {
      // Static-only host fallback: localStorage remains authoritative
    }
  }, 150);
}

function flushServerBeacon() {
  if (!dirtyForBeacon || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
  try {
    const blob = new Blob([JSON.stringify(snapshotAll())], { type: 'application/json' });
    if (navigator.sendBeacon('/api/userdata', blob)) {
      dirtyForBeacon = false;
    }
  } catch {
    // Ignore beacon error
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushServerBeacon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushServerBeacon();
  });
}

export async function hydrateStore() {
  if (typeof window === 'undefined') return;
  try {
    const res = await fetch('/api/userdata', { cache: 'no-store' });
    if (!res.ok) return;
    const remote = await res.json();
    const localTs = Number(localStorage.getItem(TS_KEY) || 0);
    const remoteTs = Number(remote.updatedAt || 0);

    if (remoteTs > 0 && (remoteTs >= localTs || localTs === 0)) {
      writeJson(SAVED_KEY, Array.isArray(remote.saved) ? remote.saved : [], false);
      writeJson(PROG_KEY, remote.progress && typeof remote.progress === 'object' ? remote.progress : {}, false);
      writeJson(PREF_KEY, remote.prefs && typeof remote.prefs === 'object' ? remote.prefs : {}, false);
      localStorage.setItem(TS_KEY, String(remoteTs));
      window.dispatchEvent(new CustomEvent('kesach:saved-change'));
      window.dispatchEvent(new CustomEvent('kesach:progress-change'));
    } else if (localTs > remoteTs) {
      scheduleServerSync();
    }
  } catch {
    // Offline or static server without /api/userdata
  }
}

export function getSaved() {
  const list = readJson(SAVED_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function isSaved(identifier) {
  return getSaved().some((item) => item.identifier === identifier);
}

export function toggleSave(book) {
  const list = getSaved();
  const idx = list.findIndex((item) => item.identifier === book.identifier);
  let saved = false;
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.unshift({
      identifier: book.identifier,
      title: book.title,
      creator: book.creator,
      langCode: book.langCode || 'SÁCH',
      year: book.year || '',
      genre: book.genre || 'novel',
      genreLabel: book.genreLabel || 'Tiểu thuyết',
      directEpubUrl: book.directEpubUrl || '',
      archivePageUrl: book.archivePageUrl || '',
      description: book.description || '',
      savedAt: Date.now()
    });
    saved = true;
  }
  writeJson(SAVED_KEY, list);
  scheduleServerSync();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kesach:saved-change', {
      detail: { identifier: book.identifier, saved, count: list.length }
    }));
  }
  return saved;
}

export function getProgress(identifier) {
  const map = readJson(PROG_KEY, {});
  const entry = map[identifier] || null;
  return entry && entry.verified ? entry : null;
}

export function getRecentProgress() {
  const map = readJson(PROG_KEY, {});
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .map(([identifier, val]) => ({ identifier, ...(val || {}) }))
    .filter((item) => item.identifier && item.title && item.verified === true)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function setProgress(bookOrId, patch) {
  const isObj = bookOrId && typeof bookOrId === 'object';
  const identifier = isObj ? bookOrId.identifier : bookOrId;
  if (!identifier) return;
  const map = readJson(PROG_KEY, {});
  const prev = map[identifier] && map[identifier].verified ? map[identifier] : {};
  const now = Date.now();
  const meta = isObj
    ? {
        identifier,
        title: bookOrId.title || prev.title || '',
        creator: bookOrId.creator || prev.creator || 'Khuyết danh',
        langCode: bookOrId.langCode || prev.langCode || 'SÁCH',
        year: bookOrId.year || prev.year || '',
        genre: bookOrId.genre || prev.genre || 'novel',
        genreLabel: bookOrId.genreLabel || prev.genreLabel || 'Sách',
        directEpubUrl: bookOrId.directEpubUrl || prev.directEpubUrl || '',
        archivePageUrl: bookOrId.archivePageUrl || prev.archivePageUrl || '',
        description: bookOrId.description || prev.description || ''
      }
    : {};

  const addSec = Number(patch && patch.addSeconds ? patch.addSeconds : 0);
  const cleanPatch = { ...(patch || {}) };
  delete cleanPatch.addSeconds;

  const rem = readJson(REMOVED_PROG_KEY, []);
  if (Array.isArray(rem) && rem.includes(identifier)) {
    writeJson(REMOVED_PROG_KEY, rem.filter((id) => id !== identifier), false);
  }

  map[identifier] = {
    ...prev,
    ...meta,
    ...cleanPatch,
    verified: true,
    readSeconds: Math.max(0, Number(prev.readSeconds || 0) + addSec),
    startedAt: prev.startedAt || now,
    updatedAt: now
  };
  writeJson(PROG_KEY, map);
  scheduleServerSync();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kesach:progress-change', {
      detail: { identifier, entry: map[identifier] }
    }));
  }
}

export function removeProgress(identifier) {
  if (!identifier) return;
  const map = readJson(PROG_KEY, {});
  if (!map[identifier]) return;
  delete map[identifier];
  writeJson(PROG_KEY, map);
  const rem = readJson(REMOVED_PROG_KEY, []);
  if (Array.isArray(rem) && !rem.includes(identifier)) {
    rem.push(identifier);
    writeJson(REMOVED_PROG_KEY, rem, false);
  }
  scheduleServerSync();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kesach:progress-change', {
      detail: { identifier, removed: true }
    }));
  }
}

export function getPrefs() {
  return {
    pageLayout: 'double',
    ...readJson(PREF_KEY, {})
  };
}

export function setPrefs(patch, touchTs = true) {
  const cur = getPrefs();
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (cur[k] !== patch[k]) {
      changed = true;
      break;
    }
  }
  if (!changed) return cur;
  const next = { ...cur, ...patch };
  writeJson(PREF_KEY, next, touchTs);
  if (touchTs) scheduleServerSync();
  return next;
}

export async function cachedFetchResponse(url, signal) {
  if (typeof window !== 'undefined' && 'caches' in window) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return hit;
      const res = await fetch(url, { signal, mode: 'cors' });
      if (res.ok) {
        cache.put(url, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
    }
  }
  return fetch(url, { signal, mode: 'cors' });
}

export async function cachedFetchText(url, signal) {
  const res = await cachedFetchResponse(url, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
