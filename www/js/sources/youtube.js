/**
 * sources/youtube.js — YouTube Data API v3 source adapter.
 *
 * Exposes:
 *   search({ query, region, timeRange, maxResults, pageToken }) -> normalized array of videos
 *   (with .nextPageToken attached to the returned array for pagination)
 *
 * Quota notes:
 *   - search.list costs 100 units per call.
 *   - videos.list costs 1 unit per call for up to 50 batched IDs.
 *   - Combined with the 15-minute localStorage cache in api.js, quota usage stays minimal.
 */

import { getSettings } from '../storage.js';

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YT_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

export const id = 'youtube';
export const name = 'YouTube Shorts';

/**
 * Compute an ISO 8601 publishedAfter timestamp for 24h / 7d / 30d ranges.
 */
function getPublishedAfter(timeRange) {
  const now = Date.now();
  const hoursMap = {
    '24h': 24,
    '7d': 24 * 7,
    '30d': 24 * 30,
  };
  const hours = hoursMap[timeRange] || 24 * 7;
  return new Date(now - hours * 60 * 60 * 1000).toISOString();
}

/**
 * Parse ISO 8601 duration (e.g. "PT58S", "PT1M12S", "PT1H2M3S") into total seconds.
 */
function parseIsoDuration(iso) {
  if (typeof iso !== 'string') return 0;
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Translate YouTube API error payloads into friendly, actionable messages.
 */
function classifyYouTubeError(err, makeError) {
  const status = err?.status || 0;
  const reason = err?.payload?.error?.errors?.[0]?.reason || '';
  const apiMessage = err?.payload?.error?.message || '';

  if (
    reason === 'keyInvalid' ||
    apiMessage.toLowerCase().includes('api key not valid') ||
    status === 400 && apiMessage.toLowerCase().includes('key')
  ) {
    return makeError(
      'INVALID_KEY',
      'Your YouTube API key is invalid. Double-check it in Settings.',
      status
    );
  }

  if (status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
    return makeError(
      'QUOTA_EXCEEDED',
      'YouTube API daily quota exceeded (10,000 units/day). Quota resets at midnight Pacific Time.',
      403
    );
  }

  if (status === 403 && reason === 'accessNotConfigured') {
    return makeError(
      'API_DISABLED',
      'YouTube Data API v3 is not enabled for this key. Enable it in Google Cloud Console.',
      403
    );
  }

  if (status === 403) {
    return makeError(
      'FORBIDDEN',
      'YouTube rejected this request (403). Check your API key restrictions or quota in Google Cloud Console.',
      403
    );
  }

  return err;
}

/**
 * Normalize a YouTube videos.list item into the shared video schema.
 */
function normalizeYouTubeVideo(item) {
  const videoId = String(item?.id || '').trim();
  if (!videoId) return null;

  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const details = item.contentDetails || {};
  const thumbs = snippet.thumbnails || {};

  const durationSec = parseIsoDuration(details.duration);
  const thumbnail =
    thumbs.high?.url ||
    thumbs.medium?.url ||
    thumbs.standard?.url ||
    thumbs.default?.url ||
    '';

  const url =
    durationSec > 0 && durationSec <= 180
      ? `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`
      : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

  return {
    id: videoId,
    platform: 'youtube',
    title: String(snippet.title || 'Untitled Short'),
    author: String(snippet.channelTitle || 'Unknown Creator'),
    thumbnail,
    url,
    views: Math.max(0, Number(stats.viewCount) || 0),
    likes: Math.max(0, Number(stats.likeCount) || 0),
    comments: Math.max(0, Number(stats.commentCount) || 0),
    publishedAt: String(snippet.publishedAt || new Date().toISOString()),
    durationSec,
  };
}

/**
 * Search YouTube Shorts and enrich with batched statistics.
 *
 * @param {object} params
 * @param {string} params.query
 * @param {string} [params.region='ALL']
 * @param {string} [params.timeRange='7d']
 * @param {number} [params.maxResults=15]
 * @param {string|null} [params.pageToken=null]
 * @param {object} [helpers] - Optional injected fetchJson/makeError from api.js
 * @returns {Promise<Array>} Normalized video array with `.nextPageToken` property
 */
export async function search(
  { query, region = 'ALL', timeRange = '7d', maxResults = 15, pageToken = null },
  helpers = {}
) {
  const makeError =
    helpers.makeError ||
    ((code, message, status = 0) => {
      const e = new Error(message);
      e.code = code;
      e.status = status;
      return e;
    });

  const fetchJson =
    helpers.fetchJson ||
    (async (url) => {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        const e = makeError('HTTP_ERROR', `HTTP ${res.status}`, res.status);
        e.payload = data;
        throw e;
      }
      return data;
    });

  const settings = getSettings();
  const apiKey = (settings.youtubeApiKey || '').trim();
  if (!apiKey) {
    throw makeError(
      'CONFIG_MISSING',
      'Missing YouTube API key. Add your key in the Settings tab.'
    );
  }

  const clampedMax = Math.min(25, Math.max(1, Number(maxResults) || 15));

  // Step 1: search.list (short videos, ordered by viewCount, filtered by publishedAfter)
  const searchParams = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoDuration: 'short',
    order: 'viewCount',
    q: query,
    publishedAfter: getPublishedAfter(timeRange),
    maxResults: String(clampedMax),
    safeSearch: 'moderate',
    key: apiKey,
  });

  if (region && region !== 'ALL') {
    searchParams.set('regionCode', region);
  }
  if (pageToken) {
    searchParams.set('pageToken', pageToken);
  }

  let searchData;
  try {
    searchData = await fetchJson(`${YT_SEARCH_URL}?${searchParams.toString()}`);
  } catch (err) {
    throw classifyYouTubeError(err, makeError);
  }

  if (!searchData || !Array.isArray(searchData.items)) {
    throw makeError('MALFORMED', 'Received an unexpected response from YouTube Search API.');
  }

  const nextPageToken = searchData.nextPageToken || null;
  const videoIds = [
    ...new Set(
      searchData.items
        .map((item) => item?.id?.videoId)
        .filter((vid) => typeof vid === 'string' && vid.length > 0)
    ),
  ];

  // Quota optimization: skip videos.list if search returned nothing
  if (videoIds.length === 0) {
    const emptyResult = [];
    emptyResult.nextPageToken = null;
    return emptyResult;
  }

  // Step 2: videos.list (single batched request for statistics + duration = 1 quota unit)
  const videosParams = new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id: videoIds.join(','),
    key: apiKey,
  });

  let detailsData;
  try {
    detailsData = await fetchJson(`${YT_VIDEOS_URL}?${videosParams.toString()}`);
  } catch (err) {
    throw classifyYouTubeError(err, makeError);
  }

  if (!detailsData || !Array.isArray(detailsData.items)) {
    throw makeError('MALFORMED', 'Received malformed video details from YouTube API.');
  }

  // Preserve original search ordering while normalizing
  const detailsById = new Map();
  for (const item of detailsData.items) {
    const normalized = normalizeYouTubeVideo(item);
    if (normalized) {
      detailsById.set(normalized.id, normalized);
    }
  }

  const results = [];
  for (const vid of videoIds) {
    const item = detailsById.get(vid);
    if (item) results.push(item);
  }

  results.nextPageToken = nextPageToken;
  return results;
}
