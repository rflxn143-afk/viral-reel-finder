/**
 * score.js — Virality Score calculator (0–100) and display formatters.
 *
 * VIRALITY SCORE FORMULA (0–100):
 *   1. Velocity Score (0–55 pts):
 *        vph = views / max(hoursSincePublish, 0.5)
 *        velocityScore = clamp((log10(vph + 1) / 5) * 55, 0, 55)
 *      (Log-scaled so 100 vph ≈ 22 pts, 1K vph ≈ 33 pts, 10K vph ≈ 44 pts, 100K+ vph = 55 pts)
 *
 *   2. Engagement Score (0–30 pts):
 *        engagementRate = views > 0 ? (likes + comments) / views : 0
 *        engagementScore = clamp((engagementRate / 0.12) * 30, 0, 30)
 *      (Caps at 12% combined like+comment rate for full 30 pts)
 *
 *   3. Recency Boost (0–15 pts):
 *        recencyBoost = 15 * exp(-hoursSincePublish / 72)
 *      (Exponential decay rewarding fresh uploads from the last 24–72 hours)
 *
 *   Final Score = round(clamp(velocityScore + engagementScore + recencyBoost, 0, 100))
 *
 *   Badges:
 *     >= 70 -> "Hot"    (green)
 *     >= 40 -> "Rising" (orange)
 *     <  40 -> "Normal" (gray)
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function computeViralityScore(video, nowMs = Date.now()) {
  const views = Math.max(0, Number(video?.views) || 0);
  const likes = Math.max(0, Number(video?.likes) || 0);
  const comments = Math.max(0, Number(video?.comments) || 0);

  const publishedMs = Date.parse(video?.publishedAt || '');
  const hoursSincePublish = Number.isFinite(publishedMs)
    ? Math.max(0.5, (nowMs - publishedMs) / (1000 * 60 * 60))
    : 168; // fallback: 7 days

  const viewsPerHour = views / hoursSincePublish;
  const velocityScore = clamp((Math.log10(viewsPerHour + 1) / 5) * 55, 0, 55);

  const engagementRate = views > 0 ? (likes + comments) / views : 0;
  const engagementScore = clamp((engagementRate / 0.12) * 30, 0, 30);

  const recencyBoost = 15 * Math.exp(-hoursSincePublish / 72);

  const score = Math.round(clamp(velocityScore + engagementScore + recencyBoost, 0, 100));

  let tier = 'normal';
  let label = 'Normal';
  if (score >= 70) {
    tier = 'hot';
    label = 'Hot';
  } else if (score >= 40) {
    tier = 'rising';
    label = 'Rising';
  }

  return {
    score,
    tier,
    label,
    viewsPerHour: Math.round(viewsPerHour),
    engagementRate,
  };
}

export function formatCompactNumber(num) {
  const n = Math.max(0, Number(num) || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

export function formatRelativeTime(isoDate) {
  const publishedMs = Date.parse(isoDate || '');
  if (!Number.isFinite(publishedMs)) return 'Unknown date';

  const diffSec = Math.max(0, Math.floor((Date.now() - publishedMs) / 1000));
  if (diffSec < 60) return 'Just now';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;

  return `${Math.floor(diffMo / 12)}y ago`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total === 0) return '';
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
