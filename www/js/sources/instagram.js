/**
 * sources/instagram.js — Plug-in Instagram Reels source adapter.
 *
 * HOW TO PLUG IN A REAL PROVIDER (Apify or RapidAPI):
 * ---------------------------------------------------------------------------
 * 1. Open the app's Settings tab and paste:
 *      - Provider Endpoint URL (HTTPS)
 *      - Provider API Key / Token
 *
 * 2. Example A — RapidAPI (e.g., Instagram Scraper / Social API):
 *      - Endpoint: https://instagram-scraper-api2.p.rapidapi.com/v1/hashtag
 *      - Key:      Your X-RapidAPI-Key
 *      - This adapter automatically detects *.rapidapi.com hosts and attaches
 *        `x-rapidapi-key` and `x-rapidapi-host` headers.
 *
 * 3. Example B — Apify Actor Sync Endpoint:
 *      - Endpoint: https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items
 *      - Key:      Your Apify Personal API Token (sent as Bearer token)
 *      - If your Apify actor expects a POST body instead of GET query params,
 *        switch the fetch options below to `method: 'POST'` with JSON body:
 *        `{ hashtags: [cleanTag], resultsLimit: maxResults }`.
 *
 * 4. Response Normalization:
 *      - `extractItems()` and `normalizeInstagramItem()` below already handle
 *        common RapidAPI and Apify response shapes. Adjust field names there
 *        if your chosen provider uses custom keys.
 * ---------------------------------------------------------------------------
 */

import { getSettings } from '../storage.js';

export const id = 'instagram';
export const name = 'Instagram Reels';

function validateEndpointUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Extract the array of items from common provider JSON envelopes.
 */
function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.reels)) return payload.reels;
  return null;
}

/**
 * Normalize a single Apify / RapidAPI reel item into our standard video object.
 */
function normalizeInstagramItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const shortcode = raw.shortcode || raw.code || raw.shortCode || '';
  const itemId = String(raw.id || raw.pk || shortcode || '').trim();
  if (!itemId) return null;

  const captionText =
    typeof raw.caption === 'string'
      ? raw.caption
      : raw.caption?.text || raw.title || raw.text || 'Instagram Reel';

  const author =
    raw.ownerUsername ||
    raw.user?.username ||
    raw.owner?.username ||
    raw.author ||
    'instagram_creator';

  const thumbnail =
    raw.displayUrl ||
    raw.thumbnail_url ||
    raw.thumbnailUrl ||
    raw.image_versions2?.candidates?.[0]?.url ||
    '';

  const url =
    raw.url ||
    (shortcode
      ? `https://www.instagram.com/reel/${encodeURIComponent(shortcode)}/`
      : 'https://www.instagram.com/');

  const views = Math.max(
    0,
    Number(
      raw.videoPlayCount ??
        raw.videoViewCount ??
        raw.play_count ??
        raw.view_count ??
        raw.views ??
        0
    ) || 0
  );

  const likes = Math.max(
    0,
    Number(raw.likesCount ?? raw.like_count ?? raw.likes ?? 0) || 0
  );

  const comments = Math.max(
    0,
    Number(raw.commentsCount ?? raw.comment_count ?? raw.comments ?? 0) || 0
  );

  let publishedAt = new Date().toISOString();
  if (raw.timestamp) {
    publishedAt = new Date(raw.timestamp).toISOString();
  } else if (raw.taken_at) {
    // Unix seconds vs milliseconds
    const ts = Number(raw.taken_at);
    publishedAt = new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
  } else if (raw.publishedAt) {
    publishedAt = new Date(raw.publishedAt).toISOString();
  }

  const durationSec = Math.max(
    0,
    Math.round(Number(raw.videoDuration ?? raw.video_duration ?? raw.durationSec ?? 0) || 0)
  );

  return {
    id: itemId,
    platform: 'instagram',
    title: String(captionText).slice(0, 140),
    author: `@${String(author).replace(/^@/, '')}`,
    thumbnail: String(thumbnail),
    url: String(url),
    views,
    likes,
    comments,
    publishedAt,
    durationSec,
  };
}

/**
 * Search Instagram Reels via the user-configured third-party provider.
 *
 * @param {object} params
 * @param {string} params.query
 * @param {string} [params.region='ALL']
 * @param {string} [params.timeRange='7d']
 * @param {number} [params.maxResults=15]
 * @param {string|null} [params.pageToken=null]
 * @param {object} [helpers]
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

  const fetchJson = helpers.fetchJson;
  const settings = getSettings();
  const rawEndpoint = (settings.instagramEndpoint || '').trim();
  const apiKey = (settings.instagramApiKey || '').trim();

  if (!rawEndpoint || !apiKey) {
    throw makeError(
      'CONFIG_MISSING',
      'Instagram source is not configured. Enter your Apify or RapidAPI endpoint + API key in Settings.'
    );
  }

  const endpointUrl = validateEndpointUrl(rawEndpoint);
  if (!endpointUrl) {
    throw makeError(
      'INVALID_CONFIG',
      'Instagram provider endpoint must be a valid HTTPS URL.'
    );
  }

  // Strip leading '#' for hashtag-based providers
  const cleanQuery = query.replace(/^#/, '').trim();
  endpointUrl.searchParams.set('query', cleanQuery);
  endpointUrl.searchParams.set('hashtag', cleanQuery);
  endpointUrl.searchParams.set('limit', String(Math.min(25, Math.max(1, maxResults))));
  if (region && region !== 'ALL') {
    endpointUrl.searchParams.set('region', region);
  }
  if (timeRange) {
    endpointUrl.searchParams.set('timeRange', timeRange);
  }
  if (pageToken) {
    endpointUrl.searchParams.set('pagination_token', pageToken);
  }

  // Auto-configure headers for RapidAPI vs standard Bearer token (Apify/custom)
  const headers = { Accept: 'application/json' };
  if (endpointUrl.hostname.endsWith('rapidapi.com')) {
    headers['x-rapidapi-key'] = apiKey;
    headers['x-rapidapi-host'] = endpointUrl.hostname;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  let payload;
  try {
    payload = await fetchJson(endpointUrl.toString(), { method: 'GET', headers });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw makeError(
        'INVALID_KEY',
        'Instagram provider rejected your API key or quota (401/403). Check Settings.',
        err.status
      );
    }
    throw err;
  }

  const rawItems = extractItems(payload);
  if (!rawItems) {
    throw makeError(
      'MALFORMED',
      'Instagram provider returned an unrecognized JSON shape. Check sources/instagram.js mapping.'
    );
  }

  const normalized = rawItems.map(normalizeInstagramItem).filter(Boolean);
  normalized.nextPageToken =
    payload?.pagination_token || payload?.nextPageToken || payload?.next_cursor || null;

  return normalized;
}
