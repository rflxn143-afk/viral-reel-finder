/**
 * ui.js — Safe DOM rendering helpers (XSS-proof: zero innerHTML on untrusted data),
 * skeleton loaders, video cards, empty states, history items, and toast notifications.
 */

import {
  computeViralityScore,
  formatCompactNumber,
  formatRelativeTime,
  formatDuration,
} from './score.js';

const FALLBACK_THUMB_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 180'%3E%3Crect width='320' height='180' fill='%231e293b'/%3E%3Ccircle cx='160' cy='90' r='28' fill='%23334155'/%3E%3Cpath d='M152 76l24 14-24 14V76z' fill='%23cbd5e1'/%3E%3C/svg%3E";

/**
 * Validate URL protocol to prevent javascript: / data: XSS injection in links/images.
 */
export function safeHttpUrl(rawUrl, fallback = '') {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return fallback;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.href;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Helper to create an element cleanly without innerHTML.
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') {
      node.className = value;
    } else if (key === 'textContent') {
      node.textContent = value;
    } else if (key.startsWith('data')) {
      const attrName = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      node.setAttribute(attrName, String(value));
    } else if (key === 'disabled' && value === true) {
      node.disabled = true;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

/**
 * Build a safe inline SVG icon for empty states (hardcoded static paths only).
 */
function createEmptyStateIcon(type) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '34');
  svg.setAttribute('height', '34');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const paths = {
    search: [
      ['circle', { cx: '11', cy: '11', r: '8' }],
      ['line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' }],
    ],
    saved: [['path', { d: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z' }]],
    history: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['polyline', { points: '12 6 12 12 16 14' }],
    ],
    error: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['line', { x1: '12', y1: '8', x2: '12', y2: '12' }],
      ['line', { x1: '12', y1: '16', x2: '12.01', y2: '16' }],
    ],
  };

  const shapes = paths[type] || paths.search;
  for (const [shapeTag, attrs] of shapes) {
    const shape = document.createElementNS(svgNS, shapeTag);
    for (const [k, v] of Object.entries(attrs)) {
      shape.setAttribute(k, v);
    }
    svg.appendChild(shape);
  }

  return el('div', { className: 'empty-state-art' }, [svg]);
}

/**
 * Show a temporary toast message.
 */
export function showToast(message, variant = 'info', durationMs = 3200) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = el('div', {
    className: `toast ${variant}`,
    textContent: String(message || ''),
  });

  container.appendChild(toast);

  // Cap simultaneous toasts to 3
  while (container.children.length > 3) {
    container.firstElementChild.remove();
  }

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease';
    setTimeout(() => toast.remove(), 220);
  }, durationMs);
}

/**
 * Render skeleton placeholder cards while loading.
 */
export function renderSkeletons(container, count = 4) {
  container.replaceChildren();
  const frag = document.createDocumentFragment();

  for (let i = 0; i < count; i += 1) {
    const card = el('div', { className: 'skeleton-card', 'aria-hidden': 'true' }, [
      el('div', { className: 'skeleton-box skeleton-thumb' }),
      el('div', { className: 'skeleton-body' }, [
        el('div', { className: 'skeleton-box skeleton-line' }),
        el('div', { className: 'skeleton-box skeleton-line short' }),
        el('div', { className: 'skeleton-actions' }, [
          el('div', { className: 'skeleton-box skeleton-btn' }),
          el('div', { className: 'skeleton-box skeleton-btn' }),
          el('div', { className: 'skeleton-box skeleton-btn' }),
          el('div', { className: 'skeleton-box skeleton-btn' }),
        ]),
      ]),
    ]);
    frag.appendChild(card);
  }

  container.appendChild(frag);
}

/**
 * Render an accessible empty or error state with optional action button.
 */
export function renderEmptyState(
  container,
  { icon = 'search', title, description, actionLabel = '', onAction = null }
) {
  container.replaceChildren();

  const children = [
    createEmptyStateIcon(icon),
    el('h3', { textContent: title }),
    el('p', { textContent: description }),
  ];

  if (actionLabel && typeof onAction === 'function') {
    const btn = el('button', {
      type: 'button',
      className: 'btn btn-primary btn-sm',
      textContent: actionLabel,
    });
    btn.addEventListener('click', onAction);
    children.push(btn);
  }

  container.appendChild(el('div', { className: 'empty-state' }, children));
}

/**
 * Build a single Video Result Card DOM element.
 */
export function createVideoCard(video, { isSaved, mode = 'search', handlers }) {
  const virality = video.virality || computeViralityScore(video);
  const safeUrl = safeHttpUrl(video.url, 'https://www.youtube.com/');
  const safeThumb = safeHttpUrl(video.thumbnail, FALLBACK_THUMB_DATA_URI);
  const durationLabel = formatDuration(video.durationSec);
  const platformLabel = video.platform === 'instagram' ? 'Instagram' : 'YouTube';

  // Thumbnail image with graceful error fallback
  const img = el('img', {
    className: 'video-thumb',
    src: safeThumb,
    alt: `${video.title} thumbnail`,
    loading: 'lazy',
    decoding: 'async',
  });
  img.addEventListener('error', () => {
    if (img.src !== FALLBACK_THUMB_DATA_URI) {
      img.src = FALLBACK_THUMB_DATA_URI;
    }
  });

  const thumbOverlayTop = el('div', { className: 'thumb-overlay-top' }, [
    el('span', { className: 'platform-pill', textContent: platformLabel }),
    el('span', {
      className: `score-badge ${virality.tier}`,
      title: `Virality Score: ${virality.score}/100 (${formatCompactNumber(virality.viewsPerHour)} views/hr)`,
      textContent: `${virality.score} • ${virality.label}`,
    }),
  ]);

  const thumbChildren = [img, thumbOverlayTop];
  if (durationLabel) {
    thumbChildren.push(el('span', { className: 'duration-pill', textContent: durationLabel }));
  }

  const thumbLink = el(
    'a',
    {
      className: 'video-thumb-wrap',
      href: safeUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `Watch ${video.title}`,
    },
    thumbChildren
  );

  // Metadata
  const titleEl = el('h3', { className: 'video-title', textContent: video.title });

  const authorRow = el('div', { className: 'video-author-row' }, [
    el('span', { className: 'video-author', textContent: video.author }),
    el('span', { className: 'video-time', textContent: formatRelativeTime(video.publishedAt) }),
  ]);

  const statsRow = el('div', { className: 'video-stats' }, [
    el('span', {
      className: 'stat-item',
      textContent: `👁 ${formatCompactNumber(video.views)} views`,
    }),
    el('span', {
      className: 'stat-item',
      textContent: `❤️ ${formatCompactNumber(video.likes)}`,
    }),
    el('span', {
      className: 'stat-item',
      textContent: `💬 ${formatCompactNumber(video.comments)}`,
    }),
  ]);

  // Action Buttons
  const openBtn = el('a', {
    className: 'card-action-btn primary',
    href: safeUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    'aria-label': `Open ${video.title}`,
    textContent: 'Open',
  });

  const saveBtn = el('button', {
    type: 'button',
    className: `card-action-btn ${isSaved ? 'saved' : ''}`,
    'aria-pressed': String(Boolean(isSaved)),
    'aria-label': mode === 'saved' ? `Remove ${video.title}` : isSaved ? `Unsave ${video.title}` : `Save ${video.title}`,
    textContent: mode === 'saved' ? 'Remove' : isSaved ? 'Saved ★' : 'Save',
  });
  saveBtn.addEventListener('click', () => handlers.onToggleSave(video, saveBtn));

  const copyBtn = el('button', {
    type: 'button',
    className: 'card-action-btn',
    'aria-label': `Copy link for ${video.title}`,
    textContent: 'Copy',
  });
  copyBtn.addEventListener('click', () => handlers.onCopy(video));

  const shareBtn = el('button', {
    type: 'button',
    className: 'card-action-btn',
    'aria-label': `Share ${video.title}`,
    textContent: 'Share',
  });
  shareBtn.addEventListener('click', () => handlers.onShare(video));

  const actionsRow = el('div', { className: 'card-actions' }, [
    openBtn,
    saveBtn,
    copyBtn,
    shareBtn,
  ]);

  const body = el('div', { className: 'video-body' }, [
    titleEl,
    authorRow,
    statsRow,
    actionsRow,
  ]);

  return el('article', { className: 'video-card' }, [thumbLink, body]);
}

/**
 * Render a list of video cards into a container.
 */
export function renderVideoList(
  container,
  videos,
  { savedSet, mode = 'search', handlers, append = false }
) {
  if (!append) {
    container.replaceChildren();
  }

  const frag = document.createDocumentFragment();
  for (const video of videos) {
    const key = `${video.platform}:${video.id}`;
    const card = createVideoCard(video, {
      isSaved: savedSet.has(key),
      mode,
      handlers,
    });
    frag.appendChild(card);
  }
  container.appendChild(frag);
}

/**
 * Render search history items.
 */
export function renderHistoryList(container, items, { onSelect, onDelete }) {
  container.replaceChildren();

  if (!items.length) {
    renderEmptyState(container, {
      icon: 'history',
      title: 'No recent searches',
      description: 'Your recent keyword and hashtag searches will appear here for one-tap reruns.',
    });
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const sourceText = item.source === 'instagram' ? 'Instagram' : 'YouTube';
    const regionText = item.region === 'ALL' ? 'Worldwide' : item.region;
    const metaText = `${sourceText} • ${regionText} • ${item.timeRange} • ${formatRelativeTime(item.searchedAt)}`;

    const mainBtn = el(
      'button',
      {
        type: 'button',
        className: 'history-main-btn',
        'aria-label': `Rerun search for ${item.query}`,
      },
      [
        el('span', { className: 'history-query', textContent: item.query }),
        el('span', { className: 'history-meta', textContent: metaText }),
      ]
    );
    mainBtn.addEventListener('click', () => onSelect(item));

    const delBtn = el('button', {
      type: 'button',
      className: 'history-delete-btn',
      'aria-label': `Remove ${item.query} from history`,
      textContent: '×',
    });
    delBtn.addEventListener('click', () => onDelete(item.id));

    frag.appendChild(el('div', { className: 'history-item' }, [mainBtn, delBtn]));
  }

  container.appendChild(frag);
}
