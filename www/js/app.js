/**
 * app.js — Main application controller for Viral Reel Finder.
 * Manages state, tab navigation, search/pagination, infinite scroll,
 * pull-to-refresh, offline detection, exports, theme, and global error handling.
 */

import {
  getSettings,
  saveSettings,
  getSavedVideos,
  toggleSaveVideo,
  removeSavedVideo,
  clearSavedVideos,
  getHistory,
  addHistoryEntry,
  removeHistoryEntry,
  clearHistory,
  clearCache,
  getStorageStats,
  resetAllData,
} from './storage.js';
import { searchVideos, sanitizeQuery } from './api.js';
import { computeViralityScore } from './score.js';
import {
  showToast,
  renderSkeletons,
  renderEmptyState,
  renderVideoList,
  renderHistoryList,
  safeHttpUrl,
} from './ui.js';

/* ==================== APPLICATION STATE ==================== */

const state = {
  activeTab: 'search',
  rawVideos: [],
  nextPageToken: null,
  lastSearchParams: null,
  fromCache: false,
  isLoading: false,
  isLoadingMore: false,
  savedFilter: '',
};

/* ==================== DOM REFERENCES ==================== */

const els = {
  offlineBanner: document.getElementById('offline-banner'),
  headerSubtitle: document.getElementById('header-subtitle'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  ptrIndicator: document.getElementById('ptr-indicator'),
  ptrText: document.getElementById('ptr-text'),
  mainContent: document.getElementById('main-content'),

  // Views & Nav
  views: {
    search: document.getElementById('view-search'),
    saved: document.getElementById('view-saved'),
    history: document.getElementById('view-history'),
    settings: document.getElementById('view-settings'),
  },
  navButtons: document.querySelectorAll('.nav-item'),
  navSavedBadge: document.getElementById('nav-saved-badge'),

  // Search Tab
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  btnClearSearch: document.getElementById('btn-clear-search'),
  btnSearchSubmit: document.getElementById('btn-search-submit'),
  chips: document.querySelectorAll('.chip'),
  filterSource: document.getElementById('filter-source'),
  filterRegion: document.getElementById('filter-region'),
  filterTimeRange: document.getElementById('filter-timerange'),
  filterSort: document.getElementById('filter-sort'),
  filterMinViews: document.getElementById('filter-minviews'),
  apiKeyPrompt: document.getElementById('api-key-prompt'),
  btnGotoSettings: document.getElementById('btn-goto-settings'),
  resultsMeta: document.getElementById('results-meta'),
  resultsCount: document.getElementById('results-count'),
  cacheBadge: document.getElementById('cache-badge'),
  searchResults: document.getElementById('search-results'),
  loadMoreWrap: document.getElementById('load-more-wrap'),
  btnLoadMore: document.getElementById('btn-load-more'),
  scrollSentinel: document.getElementById('scroll-sentinel'),

  // Saved Tab
  savedCountLabel: document.getElementById('saved-count-label'),
  savedFilterInput: document.getElementById('saved-filter-input'),
  btnExportJson: document.getElementById('btn-export-json'),
  btnExportCsv: document.getElementById('btn-export-csv'),
  btnClearSaved: document.getElementById('btn-clear-saved'),
  savedResults: document.getElementById('saved-results'),

  // History Tab
  historyCountLabel: document.getElementById('history-count-label'),
  btnClearHistory: document.getElementById('btn-clear-history'),
  historyList: document.getElementById('history-list'),

  // Settings Tab
  settingsForm: document.getElementById('settings-form'),
  settingYtKey: document.getElementById('setting-yt-key'),
  settingIgEndpoint: document.getElementById('setting-ig-endpoint'),
  settingIgKey: document.getElementById('setting-ig-key'),
  settingDefaultRegion: document.getElementById('setting-default-region'),
  settingTheme: document.getElementById('setting-theme'),
  storageStats: document.getElementById('storage-stats'),
  btnClearCache: document.getElementById('btn-clear-cache'),
  btnResetAll: document.getElementById('btn-reset-all'),
  toggleSecretBtns: document.querySelectorAll('.toggle-secret-btn'),
};

/* ==================== UTILITIES ==================== */

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function getSavedKeySet() {
  return new Set(getSavedVideos().map((v) => `${v.platform}:${v.id}`));
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
}

function updateOnlineStatus() {
  const isOffline = navigator.onLine === false;
  els.offlineBanner.hidden = !isOffline;
}

function updateSavedBadge() {
  const count = getSavedVideos().length;
  els.navSavedBadge.textContent = count > 99 ? '99+' : String(count);
  els.navSavedBadge.hidden = count === 0;
}

function updateApiKeyBanner() {
  const settings = getSettings();
  const source = els.filterSource.value;
  const missingYt = source === 'youtube' && !settings.youtubeApiKey.trim();
  const missingIg =
    source === 'instagram' &&
    (!settings.instagramEndpoint.trim() || !settings.instagramApiKey.trim());
  els.apiKeyPrompt.hidden = !(missingYt || missingIg);
}

/* ==================== GLOBAL ERROR HANDLER ==================== */

window.addEventListener('error', (event) => {
  event.preventDefault();
  showToast(event?.message || 'An unexpected error occurred.', 'error');
});

window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  const msg = event?.reason?.message || 'An unexpected async error occurred.';
  showToast(msg, 'error');
});

/* ==================== NAVIGATION ==================== */

function switchTab(tabName) {
  if (!els.views[tabName]) return;
  state.activeTab = tabName;

  for (const [name, section] of Object.entries(els.views)) {
    const active = name === tabName;
    section.hidden = !active;
    section.classList.toggle('active', active);
  }

  els.navButtons.forEach((btn) => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    if (active) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.removeAttribute('aria-current');
    }
  });

  const subtitles = {
    search: 'Discover trending shorts',
    saved: 'Your bookmarked viral reels',
    history: 'Recent searches (offline ready)',
    settings: 'API keys & preferences',
  };
  els.headerSubtitle.textContent = subtitles[tabName] || '';

  if (tabName === 'saved') renderSavedTab();
  if (tabName === 'history') renderHistoryTab();
  if (tabName === 'settings') populateSettingsTab();
  if (tabName === 'search') {
    updateApiKeyBanner();
    if (state.rawVideos.length > 0) {
      renderFilteredSearchResults();
    }
  }
}

/* ==================== CARD ACTIONS ==================== */

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

const cardHandlers = {
  onToggleSave(video, btnEl) {
    if (state.activeTab === 'saved') {
      removeSavedVideo(video.platform, video.id);
      updateSavedBadge();
      renderSavedTab();
      showToast('Removed from Saved.');
      return;
    }

    const { saved } = toggleSaveVideo(video);
    updateSavedBadge();
    if (btnEl) {
      btnEl.classList.toggle('saved', saved);
      btnEl.setAttribute('aria-pressed', String(saved));
      btnEl.textContent = saved ? 'Saved ★' : 'Save';
    }
    showToast(saved ? 'Saved to bookmarks.' : 'Removed from Saved.', saved ? 'success' : 'info');
  },

  async onCopy(video) {
    const url = safeHttpUrl(video.url);
    if (!url) {
      showToast('Invalid video URL.', 'error');
      return;
    }
    const ok = await copyText(url);
    showToast(ok ? 'Link copied to clipboard!' : 'Could not copy link.', ok ? 'success' : 'error');
  },

  async onShare(video) {
    const url = safeHttpUrl(video.url);
    if (!url) {
      showToast('Invalid video URL.', 'error');
      return;
    }
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: video.title,
          text: `${video.title} — ${video.author}`,
          url,
        });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    // Fallback to copy
    const ok = await copyText(url);
    showToast(ok ? 'Share unavailable — link copied instead!' : 'Could not share link.');
  },
};

/* ==================== SEARCH & FILTERING ==================== */

function getFilteredAndSortedVideos(videos) {
  const minViews = Number(els.filterMinViews.value) || 0;
  const sortBy = els.filterSort.value || 'virality';

  const filtered = videos.filter((v) => (Number(v.views) || 0) >= minViews);

  return filtered.sort((a, b) => {
    if (sortBy === 'views') {
      return (b.views || 0) - (a.views || 0);
    }
    if (sortBy === 'newest') {
      return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
    }
    // Default: virality score descending, tie-break by views
    const scoreA = a.virality?.score ?? computeViralityScore(a).score;
    const scoreB = b.virality?.score ?? computeViralityScore(b).score;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (b.views || 0) - (a.views || 0);
  });
}

function renderFilteredSearchResults() {
  const processed = getFilteredAndSortedVideos(state.rawVideos);
  const totalFetched = state.rawVideos.length;

  els.resultsMeta.hidden = totalFetched === 0;
  els.resultsCount.textContent =
    processed.length === totalFetched
      ? `${processed.length} video${processed.length === 1 ? '' : 's'}`
      : `${processed.length} of ${totalFetched} videos (filtered)`;
  els.cacheBadge.hidden = !state.fromCache;

  if (totalFetched === 0) {
    renderEmptyState(els.searchResults, {
      icon: 'search',
      title: 'No viral reels found',
      description: 'Try a broader keyword, switch to "Last 30 days", or change the region to Worldwide.',
    });
    els.loadMoreWrap.hidden = true;
    return;
  }

  if (processed.length === 0) {
    renderEmptyState(els.searchResults, {
      icon: 'search',
      title: 'Filtered out by Min Views',
      description: 'None of the fetched videos meet your current minimum views filter. Lower the filter to see them.',
      actionLabel: 'Reset Min Views',
      onAction: () => {
        els.filterMinViews.value = '0';
        renderFilteredSearchResults();
      },
    });
  } else {
    renderVideoList(els.searchResults, processed, {
      savedSet: getSavedKeySet(),
      mode: 'search',
      handlers: cardHandlers,
      append: false,
    });
  }

  els.loadMoreWrap.hidden = !state.nextPageToken;
}

function setSearchLoading(loading) {
  state.isLoading = loading;
  els.btnSearchSubmit.disabled = loading;
  els.btnSearchSubmit.textContent = loading ? 'Searching...' : 'Search';
  els.btnRefresh.disabled = loading;
  els.btnRefresh.classList.toggle('spinning', loading);
}

async function runSearch({ bypassCache = false } = {}) {
  if (state.isLoading) return;

  const query = sanitizeQuery(els.searchInput.value);
  els.searchInput.value = query;
  els.btnClearSearch.hidden = !query;

  if (!query) {
    showToast('Enter a keyword, niche, or hashtag to search.', 'info');
    els.searchInput.focus();
    return;
  }

  const params = {
    source: els.filterSource.value,
    query,
    region: els.filterRegion.value,
    timeRange: els.filterTimeRange.value,
    maxResults: 15,
    pageToken: null,
    bypassCache,
  };

  setSearchLoading(true);
  els.resultsMeta.hidden = true;
  els.loadMoreWrap.hidden = true;
  renderSkeletons(els.searchResults, 4);

  try {
    const result = await searchVideos(params);
    state.rawVideos = result.videos;
    state.nextPageToken = result.nextPageToken;
    state.fromCache = result.fromCache;
    state.lastSearchParams = { ...params };

    addHistoryEntry({
      query,
      source: params.source,
      region: params.region,
      timeRange: params.timeRange,
      resultCount: result.videos.length,
    });

    renderFilteredSearchResults();
  } catch (err) {
    state.rawVideos = [];
    state.nextPageToken = null;
    els.resultsMeta.hidden = true;
    els.loadMoreWrap.hidden = true;

    const needsSettings =
      err?.code === 'CONFIG_MISSING' ||
      err?.code === 'INVALID_KEY' ||
      err?.code === 'INVALID_CONFIG';

    renderEmptyState(els.searchResults, {
      icon: 'error',
      title: err?.code === 'OFFLINE' ? 'You are offline' : 'Search failed',
      description: err?.message || 'Unable to fetch videos right now.',
      actionLabel: needsSettings ? 'Open Settings' : 'Try Again',
      onAction: needsSettings ? () => switchTab('settings') : () => runSearch({ bypassCache: true }),
    });

    showToast(err?.message || 'Search failed.', 'error');
  } finally {
    setSearchLoading(false);
  }
}

async function loadMoreVideos() {
  if (state.isLoading || state.isLoadingMore || !state.nextPageToken || !state.lastSearchParams) {
    return;
  }

  state.isLoadingMore = true;
  els.btnLoadMore.disabled = true;
  els.btnLoadMore.textContent = 'Loading more...';

  try {
    const result = await searchVideos({
      ...state.lastSearchParams,
      pageToken: state.nextPageToken,
      bypassCache: false,
    });

    // Deduplicate against already loaded videos
    const existingKeys = new Set(state.rawVideos.map((v) => `${v.platform}:${v.id}`));
    const fresh = result.videos.filter((v) => !existingKeys.has(`${v.platform}:${v.id}`));

    state.rawVideos = [...state.rawVideos, ...fresh];
    state.nextPageToken = result.nextPageToken;
    state.fromCache = result.fromCache;

    renderFilteredSearchResults();
  } catch (err) {
    showToast(err?.message || 'Could not load more videos.', 'error');
  } finally {
    state.isLoadingMore = false;
    els.btnLoadMore.disabled = false;
    els.btnLoadMore.textContent = 'Load more';
  }
}

/* ==================== SAVED TAB & EXPORTS ==================== */

function renderSavedTab() {
  const allSaved = getSavedVideos();
  const term = state.savedFilter.trim().toLowerCase();

  const filtered = term
    ? allSaved.filter(
        (v) =>
          (v.title || '').toLowerCase().includes(term) ||
          (v.author || '').toLowerCase().includes(term) ||
          (v.platform || '').toLowerCase().includes(term)
      )
    : allSaved;

  els.savedCountLabel.textContent = `${allSaved.length} saved video${allSaved.length === 1 ? '' : 's'}`;
  els.btnExportJson.disabled = allSaved.length === 0;
  els.btnExportCsv.disabled = allSaved.length === 0;
  els.btnClearSaved.disabled = allSaved.length === 0;

  if (allSaved.length === 0) {
    renderEmptyState(els.savedResults, {
      icon: 'saved',
      title: 'No saved reels yet',
      description: 'Tap "Save" on any video card to build your swipe file. Works completely offline.',
      actionLabel: 'Find Viral Reels',
      onAction: () => switchTab('search'),
    });
    return;
  }

  if (filtered.length === 0) {
    renderEmptyState(els.savedResults, {
      icon: 'search',
      title: 'No matching bookmarks',
      description: `No saved videos match "${state.savedFilter}".`,
    });
    return;
  }

  const enriched = filtered.map((v) => ({
    ...v,
    virality: computeViralityScore(v),
  }));

  renderVideoList(els.savedResults, enriched, {
    savedSet: getSavedKeySet(),
    mode: 'saved',
    handlers: cardHandlers,
  });
}

function escapeCsvCell(value) {
  let str = String(value ?? '');
  // Guard against spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportSavedJson() {
  const items = getSavedVideos();
  if (!items.length) return;
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(
    `viral-reels-${stamp}.json`,
    JSON.stringify(items, null, 2),
    'application/json;charset=utf-8'
  );
  showToast(`Exported ${items.length} reels as JSON.`, 'success');
}

function exportSavedCsv() {
  const items = getSavedVideos();
  if (!items.length) return;

  const headers = [
    'id',
    'platform',
    'title',
    'author',
    'url',
    'views',
    'likes',
    'comments',
    'viralityScore',
    'publishedAt',
    'durationSec',
    'savedAt',
  ];

  const rows = [headers.join(',')];
  for (const v of items) {
    const score = computeViralityScore(v).score;
    rows.push(
      [
        v.id,
        v.platform,
        v.title,
        v.author,
        v.url,
        v.views,
        v.likes,
        v.comments,
        score,
        v.publishedAt,
        v.durationSec,
        v.savedAt || '',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  }

  const stamp = new Date().toISOString().slice(0, 10);
  // Prepend UTF-8 BOM for Excel compatibility
  downloadFile(
    `viral-reels-${stamp}.csv`,
    `\uFEFF${rows.join('\r\n')}`,
    'text/csv;charset=utf-8'
  );
  showToast(`Exported ${items.length} reels as CSV.`, 'success');
}

/* ==================== HISTORY TAB ==================== */

function renderHistoryTab() {
  const items = getHistory();
  els.historyCountLabel.textContent = items.length
    ? `${items.length} recent search${items.length === 1 ? '' : 'es'} — tap to rerun`
    : 'Tap any search to rerun';
  els.btnClearHistory.disabled = items.length === 0;

  renderHistoryList(els.historyList, items, {
    onSelect: (entry) => {
      els.searchInput.value = entry.query;
      els.filterSource.value = entry.source || 'youtube';
      els.filterRegion.value = entry.region || 'ALL';
      els.filterTimeRange.value = entry.timeRange || '7d';
      els.btnClearSearch.hidden = false;
      switchTab('search');
      runSearch({ bypassCache: false });
    },
    onDelete: (id) => {
      removeHistoryEntry(id);
      renderHistoryTab();
      showToast('Removed history item.');
    },
  });
}

/* ==================== SETTINGS TAB ==================== */

function populateSettingsTab() {
  const settings = getSettings();
  els.settingYtKey.value = settings.youtubeApiKey;
  els.settingIgEndpoint.value = settings.instagramEndpoint;
  els.settingIgKey.value = settings.instagramApiKey;
  els.settingDefaultRegion.value = settings.defaultRegion;
  els.settingTheme.value = settings.theme;

  const stats = getStorageStats();
  els.storageStats.textContent = `${stats.savedCount} saved reels • ${stats.historyCount} history items • ${stats.cacheCount} cached API queries (15-min TTL)`;
}

/* ==================== INFINITE SCROLL & PULL-TO-REFRESH ==================== */

function setupInfiniteScroll() {
  if (!('IntersectionObserver' in window) || !els.scrollSentinel) return;

  const observer = new IntersectionObserver(
    (entries) => {
      if (
        entries[0]?.isIntersecting &&
        state.activeTab === 'search' &&
        state.nextPageToken &&
        !state.isLoading &&
        !state.isLoadingMore
      ) {
        loadMoreVideos();
      }
    },
    { rootMargin: '220px' }
  );

  observer.observe(els.scrollSentinel);
}

function setupPullToRefresh() {
  let startY = 0;
  let pulling = false;

  els.mainContent.addEventListener(
    'touchstart',
    (e) => {
      if (state.activeTab !== 'search' || window.scrollY > 0 || state.isLoading) return;
      if (e.touches.length === 1) {
        startY = e.touches[0].clientY;
        pulling = true;
      }
    },
    { passive: true }
  );

  els.mainContent.addEventListener(
    'touchmove',
    (e) => {
      if (!pulling) return;
      const deltaY = e.touches[0].clientY - startY;
      if (deltaY > 45 && window.scrollY === 0) {
        els.ptrIndicator.classList.add('visible');
        els.ptrText.textContent = deltaY > 90 ? 'Release to refresh' : 'Pull to refresh';
      } else {
        els.ptrIndicator.classList.remove('visible');
      }
    },
    { passive: true }
  );

  els.mainContent.addEventListener('touchend', (e) => {
    if (!pulling) return;
    pulling = false;
    const endY = e.changedTouches[0]?.clientY || startY;
    const deltaY = endY - startY;

    if (deltaY > 90 && window.scrollY === 0 && els.searchInput.value.trim()) {
      els.ptrIndicator.classList.add('refreshing');
      els.ptrText.textContent = 'Refreshing...';
      runSearch({ bypassCache: true }).finally(() => {
        els.ptrIndicator.classList.remove('visible', 'refreshing');
      });
    } else {
      els.ptrIndicator.classList.remove('visible', 'refreshing');
    }
  });
}

/* ==================== SERVICE WORKER REGISTRATION ==================== */

function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Service Worker registration failure should never block the app
    });
  }
}

/* ==================== EVENT BINDINGS & INIT ==================== */

function bindEvents() {
  // Online / Offline listeners
  window.addEventListener('online', () => {
    updateOnlineStatus();
    showToast('Back online!', 'success');
  });
  window.addEventListener('offline', () => {
    updateOnlineStatus();
    showToast('You are offline. Saved & History still work.');
  });

  // Bottom Navigation
  els.navButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Header buttons
  els.btnRefresh.addEventListener('click', () => {
    if (state.activeTab === 'search') {
      if (els.searchInput.value.trim()) {
        runSearch({ bypassCache: true });
      } else {
        showToast('Enter a keyword first to refresh results.');
      }
    } else if (state.activeTab === 'saved') {
      renderSavedTab();
      showToast('Saved reels refreshed.');
    } else if (state.activeTab === 'history') {
      renderHistoryTab();
    } else {
      populateSettingsTab();
    }
  });

  els.btnThemeToggle.addEventListener('click', () => {
    const current = getSettings().theme;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effectiveDark = current === 'dark' || (current === 'system' && prefersDark);
    const nextTheme = effectiveDark ? 'light' : 'dark';
    saveSettings({ theme: nextTheme });
    applyTheme(nextTheme);
    if (state.activeTab === 'settings') els.settingTheme.value = nextTheme;
    showToast(`Switched to ${nextTheme} theme.`);
  });

  // Search form & debounced search input
  els.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch({ bypassCache: false });
  });

  const debouncedInputSync = debounce(() => {
    const val = sanitizeQuery(els.searchInput.value);
    els.btnClearSearch.hidden = !val;
  }, 250);

  els.searchInput.addEventListener('input', () => {
    els.btnClearSearch.hidden = !els.searchInput.value;
    debouncedInputSync();
  });

  els.btnClearSearch.addEventListener('click', () => {
    els.searchInput.value = '';
    els.btnClearSearch.hidden = true;
    els.searchInput.focus();
  });

  // Quick niche chips
  els.chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      els.searchInput.value = chip.dataset.query || '';
      els.btnClearSearch.hidden = false;
      runSearch({ bypassCache: false });
    });
  });

  // Filters
  const debouncedFilterSearch = debounce(() => {
    if (els.searchInput.value.trim()) {
      runSearch({ bypassCache: false });
    }
  }, 300);

  els.filterSource.addEventListener('change', () => {
    updateApiKeyBanner();
    debouncedFilterSearch();
  });
  els.filterRegion.addEventListener('change', debouncedFilterSearch);
  els.filterTimeRange.addEventListener('change', debouncedFilterSearch);

  // Client-side sort & min views (instant, 0 API quota)
  els.filterSort.addEventListener('change', () => {
    if (state.rawVideos.length > 0) renderFilteredSearchResults();
  });
  els.filterMinViews.addEventListener('change', () => {
    if (state.rawVideos.length > 0) renderFilteredSearchResults();
  });

  els.btnGotoSettings.addEventListener('click', () => switchTab('settings'));
  els.btnLoadMore.addEventListener('click', loadMoreVideos);

  // Saved Tab
  const debouncedSavedFilter = debounce((val) => {
    state.savedFilter = val;
    renderSavedTab();
  }, 200);

  els.savedFilterInput.addEventListener('input', (e) => {
    debouncedSavedFilter(e.target.value);
  });
  els.btnExportJson.addEventListener('click', exportSavedJson);
  els.btnExportCsv.addEventListener('click', exportSavedCsv);
  els.btnClearSaved.addEventListener('click', () => {
    if (!window.confirm('Remove all saved reels? This cannot be undone.')) return;
    clearSavedVideos();
    updateSavedBadge();
    renderSavedTab();
    showToast('Cleared all saved reels.');
  });

  // History Tab
  els.btnClearHistory.addEventListener('click', () => {
    if (!window.confirm('Clear all search history?')) return;
    clearHistory();
    renderHistoryTab();
    showToast('Search history cleared.');
  });

  // Settings Tab
  els.toggleSecretBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    });
  });

  els.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const igEndpoint = els.settingIgEndpoint.value.trim();
    if (igEndpoint) {
      try {
        const parsed = new URL(igEndpoint);
        if (parsed.protocol !== 'https:') {
          showToast('Instagram endpoint URL must use HTTPS.', 'error');
          return;
        }
      } catch {
        showToast('Instagram endpoint is not a valid URL.', 'error');
        return;
      }
    }

    const updated = saveSettings({
      youtubeApiKey: els.settingYtKey.value.trim(),
      instagramEndpoint: igEndpoint,
      instagramApiKey: els.settingIgKey.value.trim(),
      defaultRegion: els.settingDefaultRegion.value,
      theme: els.settingTheme.value,
    });

    applyTheme(updated.theme);
    els.filterRegion.value = updated.defaultRegion;
    updateApiKeyBanner();
    populateSettingsTab();
    showToast('Settings saved locally!', 'success');
  });

  els.btnClearCache.addEventListener('click', () => {
    clearCache();
    populateSettingsTab();
    showToast('API response cache cleared.', 'success');
  });

  els.btnResetAll.addEventListener('click', () => {
    if (!window.confirm('Reset ALL settings, API keys, saved reels, history, and cache?')) return;
    resetAllData();
    state.rawVideos = [];
    state.nextPageToken = null;
    applyTheme('system');
    els.filterRegion.value = 'ALL';
    updateSavedBadge();
    populateSettingsTab();
    updateApiKeyBanner();
    showToast('All local data has been reset.');
  });
}

function init() {
  const settings = getSettings();
  applyTheme(settings.theme);
  els.filterRegion.value = settings.defaultRegion || 'ALL';

  updateOnlineStatus();
  updateSavedBadge();
  updateApiKeyBanner();

  renderEmptyState(els.searchResults, {
    icon: 'search',
    title: 'Find what is going viral right now',
    description: 'Search any keyword, niche, or #hashtag—or tap a topic chip above—to rank short videos by Virality Score.',
  });

  bindEvents();
  setupInfiniteScroll();
  setupPullToRefresh();
  registerServiceWorker();
}

init();
