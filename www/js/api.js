/**
 * api.js — Resilient network layer, source adapter router, input sanitizer,
 * request deduplication, 10s timeout, exponential backoff (max 3 retries),
 * and 15-minute TTL response caching.
 */

import { getCachedResult, setCachedResult } from './storage.js';
import { computeViralityScore } from './score.js';
import * as youtubeSource from './sources/youtube.js';
import * as instagramSource from './sources/instagram.js';

const SOURCES = {
  youtube: youtubeSource,
  instagram: instagramSource,
};

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class AppError extends Error {
  constructor(code, message, status = 0, payload = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

export function makeError(code, message, status = 0, payload = null) {
  return new AppError(code, message, status, payload);
}

/**
 * Sanitize and validate user search input.
 */
export function sanitizeQuery(raw) {
  if (typeof raw !== 'string') return '';
  // Strip control characters, collapse whitespace, cap length at 100 chars
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a single fetch with an AbortController 10s timeout.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new AppError(
        'TIMEOUT',
        'Request timed out after 10 seconds. Check your connection and try again.'
      );
    }
    throw new AppError(
      'NETWORK',
      'Network error while reaching the API. Please check your internet connection.'
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch JSON with 10s timeout and exponential backoff (up to 3 attempts total).
 */
export async function fetchJsonWithRetry(url, options = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AppError(
      'OFFLINE',
      'No internet connection. Your Saved reels and History are still available offline.'
    );
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, FETCH_TIMEOUT_MS);
      const rawText = await response.text();

      let parsed = null;
      if (rawText) {
        try {
          parsed = JSON.parse(rawText);
        } catch {
          if (response.ok) {
            throw new AppError(
              'MALFORMED',
              'API returned malformed JSON. Please try again later.',
              response.status
            );
          }
        }
      }

      if (!response.ok) {
        const httpErr = new AppError(
          'HTTP_ERROR',
          `API request failed with status ${response.status}.`,
          response.status,
          parsed
        );

        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
          lastError = httpErr;
          const delayMs = Math.pow(2, attempt - 1) * 800 + Math.random() * 250;
          await sleep(delayMs);
          continue;
        }
        throw httpErr;
      }

      if (parsed === null) {
        throw new AppError('MALFORMED', 'API returned an empty response.', response.status);
      }

      return parsed;
    } catch (err) {
      lastError = err;
      const isRetryable =
        err instanceof AppError &&
        (err.code === 'TIMEOUT' || err.code === 'NETWORK' || RETRYABLE_STATUSES.has(err.status));

      if (isRetryable && attempt < MAX_RETRIES) {
        const delayMs = Math.pow(2, attempt - 1) * 800 + Math.random() * 250;
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new AppError('UNKNOWN', 'Request failed after multiple retries.');
}

// Track active in-flight requests to prevent duplicate concurrent API calls
const inflightRequests = new Map();

function buildCacheKey({ source, query, region, timeRange, pageToken }) {
  return [
    source,
    query.toLowerCase(),
    region || 'ALL',
    timeRange || '7d',
    pageToken || 'FIRST',
  ].join('|');
}

/**
 * Search videos through the selected adapter with caching & deduplication.
 */
export async function searchVideos({
  source = 'youtube',
  query,
  region = 'ALL',
  timeRange = '7d',
  maxResults = 15,
  pageToken = null,
  bypassCache = false,
}) {
  const adapter = SOURCES[source];
  if (!adapter) {
    throw new AppError('INVALID_SOURCE', `Unsupported video source: ${source}`);
  }

  const cleanQuery = sanitizeQuery(query);
  if (!cleanQuery) {
    throw new AppError('INVALID_INPUT', 'Please enter a keyword, niche, or hashtag to search.');
  }

  const cacheKey = buildCacheKey({
    source,
    query: cleanQuery,
    region,
    timeRange,
    pageToken,
  });

  // 1. Return cached response if fresh and cache isn't bypassed
  if (!bypassCache) {
    const cached = getCachedResult(cacheKey);
    if (cached) {
      const scored = cached.videos.map((v) => ({
        ...v,
        virality: computeViralityScore(v),
      }));
      return {
        videos: scored,
        nextPageToken: cached.nextPageToken,
        fromCache: true,
      };
    }
  }

  // 2. Deduplicate identical concurrent in-flight calls
  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    const rawVideos = await adapter.search(
      {
        query: cleanQuery,
        region,
        timeRange,
        maxResults,
        pageToken,
      },
      {
        fetchJson: fetchJsonWithRetry,
        makeError,
      }
    );

    if (!Array.isArray(rawVideos)) {
      throw new AppError('MALFORMED', 'Source adapter returned invalid video list.');
    }

    const nextPageToken = rawVideos.nextPageToken || null;
    setCachedResult(cacheKey, rawVideos, nextPageToken);

    const scored = rawVideos.map((v) => ({
      ...v,
      virality: computeViralityScore(v),
    }));

    return {
      videos: scored,
      nextPageToken,
      fromCache: false,
    };
  })();

  inflightRequests.set(cacheKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}
