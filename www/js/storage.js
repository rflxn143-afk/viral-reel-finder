/**
 * storage.js — Persistent localStorage wrapper for settings, saved videos,
 * search history, and 15-minute TTL API response cache.
 */

const KEYS = {
  SETTINGS: 'vrf_settings_v1',
  SAVED: 'vrf_saved_v1',
  HISTORY: 'vrf_history_v1',
  CACHE: 'vrf_cache_v1',
};

export const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_HISTORY_ITEMS = 30;
const MAX_CACHE_ENTRIES = 25;

const DEFAULT_SETTINGS = Object.freeze({
  youtubeApiKey: '',
  instagramEndpoint: '',
  instagramApiKey: '',
  defaultRegion: 'ALL',
  theme: 'system', // 'system' | 'light' | 'dark'
});

function safeRead(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    // Handle QuotaExceededError by purging API cache and retrying once
    if (key !== KEYS.CACHE) {
      try {
        window.localStorage.removeItem(KEYS.CACHE);
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/* ==================== SETTINGS ==================== */

export function getSettings() {
  const stored = safeRead(KEYS.SETTINGS, {});
  return {
    ...DEFAULT_SETTINGS,
    ...(typeof stored === 'object' && stored !== null ? stored : {}),
  };
}

export function saveSettings(partial) {
  const next = {
    ...getSettings(),
    ...partial,
  };
  safeWrite(KEYS.SETTINGS, next);
  return next;
}

/* ==================== SAVED VIDEOS ==================== */

export function getSavedVideos() {
  const list = safeRead(KEYS.SAVED, []);
  return Array.isArray(list) ? list : [];
}

export function isVideoSaved(platform, id) {
  const composite = `${platform}:${id}`;
  return getSavedVideos().some((v) => `${v.platform}:${v.id}` === composite);
}

export function toggleSaveVideo(video) {
  const list = getSavedVideos();
  const composite = `${video.platform}:${video.id}`;
  const idx = list.findIndex((v) => `${v.platform}:${v.id}` === composite);

  if (idx >= 0) {
    list.splice(idx, 1);
    safeWrite(KEYS.SAVED, list);
    return { saved: false, list };
  }

  const record = {
    ...video,
    savedAt: new Date().toISOString(),
  };
  list.unshift(record);
  safeWrite(KEYS.SAVED, list);
  return { saved: true, list };
}

export function removeSavedVideo(platform, id) {
  const composite = `${platform}:${id}`;
  const next = getSavedVideos().filter((v) => `${v.platform}:${v.id}` !== composite);
  safeWrite(KEYS.SAVED, next);
  return next;
}

export function clearSavedVideos() {
  safeWrite(KEYS.SAVED, []);
}

/* ==================== SEARCH HISTORY ==================== */

export function getHistory() {
  const list = safeRead(KEYS.HISTORY, []);
  return Array.isArray(list) ? list : [];
}

export function addHistoryEntry({ query, source, region, timeRange, resultCount = 0 }) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return getHistory();

  const list = getHistory().filter(
    (item) =>
      !(
        item.query.toLowerCase() === cleanQuery.toLowerCase() &&
        item.source === source &&
        item.region === region &&
        item.timeRange === timeRange
      )
  );

  list.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    query: cleanQuery,
    source,
    region,
    timeRange,
    resultCount,
    searchedAt: new Date().toISOString(),
  });

  const trimmed = list.slice(0, MAX_HISTORY_ITEMS);
  safeWrite(KEYS.HISTORY, trimmed);
  return trimmed;
}

export function removeHistoryEntry(id) {
  const next = getHistory().filter((item) => item.id !== id);
  safeWrite(KEYS.HISTORY, next);
  return next;
}

export function clearHistory() {
  safeWrite(KEYS.HISTORY, []);
}

/* ==================== API CACHE (15-MIN TTL) ==================== */

function readCacheStore() {
  const store = safeRead(KEYS.CACHE, {});
  return typeof store === 'object' && store !== null ? store : {};
}

export function getCachedResult(cacheKey) {
  const store = readCacheStore();
  const entry = store[cacheKey];
  if (!entry) return null;

  const age = Date.now() - entry.timestamp;
  if (age > CACHE_TTL_MS || !Array.isArray(entry.videos)) {
    delete store[cacheKey];
    safeWrite(KEYS.CACHE, store);
    return null;
  }

  return {
    videos: entry.videos,
    nextPageToken: entry.nextPageToken || null,
    cachedAt: entry.timestamp,
  };
}

export function setCachedResult(cacheKey, videos, nextPageToken = null) {
  const store = readCacheStore();
  const now = Date.now();

  // Prune expired entries first
  for (const key of Object.keys(store)) {
    if (now - (store[key]?.timestamp || 0) > CACHE_TTL_MS) {
      delete store[key];
    }
  }

  // Enforce max entry limit (evict oldest)
  const keys = Object.keys(store);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    keys
      .sort((a, b) => (store[a]?.timestamp || 0) - (store[b]?.timestamp || 0))
      .slice(0, keys.length - MAX_CACHE_ENTRIES + 1)
      .forEach((k) => delete store[k]);
  }

  store[cacheKey] = {
    timestamp: now,
    videos: Array.from(videos),
    nextPageToken: nextPageToken || null,
  };

  safeWrite(KEYS.CACHE, store);
}

export function clearCache() {
  try {
    window.localStorage.removeItem(KEYS.CACHE);
  } catch {
    // Ignore storage errors
  }
}

export function getStorageStats() {
  const cacheObj = readCacheStore();
  const validCacheCount = Object.values(cacheObj).filter(
    (entry) => Date.now() - (entry?.timestamp || 0) <= CACHE_TTL_MS
  ).length;

  return {
    savedCount: getSavedVideos().length,
    historyCount: getHistory().length,
    cacheCount: validCacheCount,
  };
}

export function resetAllData() {
  Object.values(KEYS).forEach((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage errors
    }
  });
}
