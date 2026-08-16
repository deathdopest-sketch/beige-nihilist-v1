'use strict';

/** Pick random element from array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Pick random element, avoiding recently used items. */
function pickAvoidingRecent(pool, recentList, maxRecent = 5) {
  const recent = recentList.slice(-maxRecent);
  const candidates = pool.filter(x => !recent.includes(x));
  const source = candidates.length > 0 ? candidates : pool;
  const choice = source[Math.floor(Math.random() * source.length)];
  recentList.push(choice);
  if (recentList.length > maxRecent * 2) recentList.splice(0, maxRecent);
  return choice;
}

/** Split a message into chunks at word boundaries. */
function splitMessage(text, maxLen = 400) {
  if (!text || text.length <= maxLen) return [text];
  const parts = [];
  let current = '';
  for (const word of text.split(' ')) {
    if ((current + ' ' + word).trim().length > maxLen) {
      if (current) parts.push(current.trim());
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) parts.push(current.trim());
  return parts.filter(Boolean);
}

/** Wait ms milliseconds. */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Shuffle array in place (Fisher-Yates). */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Clamp value between min and max. */
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/** Format ms duration to human readable. */
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

module.exports = { pick, pickAvoidingRecent, splitMessage, sleep, shuffleArray, clamp, formatDuration };
