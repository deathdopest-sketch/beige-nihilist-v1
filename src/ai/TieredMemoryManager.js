'use strict';

/**
 * TieredMemoryManager
 *
 * Short-term:
 * - Per-room rolling message window
 * - Lightweight periodic summaries of evicted messages
 *
 * Profile:
 * - Per-user key/value memory map (bounded)
 *
 * Design goals:
 * - Strict input validation
 * - Bounded memory usage
 * - Safe serialization / restore
 * - Health snapshot for ops visibility
 */
class TieredMemoryManager {
  constructor(config = {}) {
    this.config = {
      shortTermWindow : Number.isFinite(config.shortTermWindow) ? Math.max(20, Math.min(400, config.shortTermWindow)) : 90,
      summaryThreshold: Number.isFinite(config.summaryThreshold) ? Math.max(4, Math.min(80, config.summaryThreshold)) : 12,
      maxProfileSize  : Number.isFinite(config.maxProfileSize) ? Math.max(50, Math.min(5000, config.maxProfileSize)) : 800,
      maxRooms        : Number.isFinite(config.maxRooms) ? Math.max(2, Math.min(200, config.maxRooms)) : 40,
      maxSummariesPerRoom: Number.isFinite(config.maxSummariesPerRoom) ? Math.max(2, Math.min(80, config.maxSummariesPerRoom)) : 12,
      maxContentLength: Number.isFinite(config.maxContentLength) ? Math.max(80, Math.min(6000, config.maxContentLength)) : 1200,
    };

    // roomKey -> [{ role, nick, content, ts, id }]
    this.shortTerm = new Map();
    // roomKey -> [{ text, ts, messageCount, topics[] }]
    this.summaries = new Map();
    // userKey -> Map(memoryKey -> { value, ts })
    this.profiles = new Map();

    this.metrics = {
      addedMessages      : 0,
      rejectedMessages   : 0,
      contentClamped     : 0,
      summariesCreated   : 0,
      profileWrites      : 0,
      profileEvictions   : 0,
      profileReadHits    : 0,
      profileReadMisses  : 0,
      lastCleanupTs      : 0,
    };
  }

  // ── Validation ────────────────────────────────────────────────────────────

  _isRole(role) {
    return role === 'user' || role === 'assistant' || role === 'system';
  }

  _normRoomKey(roomKey) {
    const k = String(roomKey || '').trim();
    return k || null;
  }

  _normUserKey(userKey) {
    const k = String(userKey || '').trim().toLowerCase();
    return k || null;
  }

  _normContent(content) {
    if (typeof content !== 'string') return null;
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (trimmed.length > this.config.maxContentLength) {
      this.metrics.contentClamped++;
      return trimmed.slice(0, this.config.maxContentLength);
    }
    return trimmed;
  }

  _evictOldestRoomIfNeeded() {
    if (this.shortTerm.size < this.config.maxRooms) return;
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [rk, arr] of this.shortTerm.entries()) {
      const ts = arr[0]?.ts ?? Infinity;
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = rk;
      }
    }
    if (oldestKey) {
      this.shortTerm.delete(oldestKey);
      this.summaries.delete(oldestKey);
    }
  }

  // ── Message memory ────────────────────────────────────────────────────────

  /**
   * Add one chat event into tiered memory.
   * @returns {{ok:boolean, reason?:string}}
   */
  addMessage({ roomKey, role, nick, content, ts }) {
    const rk = this._normRoomKey(roomKey);
    if (!rk) {
      this.metrics.rejectedMessages++;
      return { ok: false, reason: 'invalid_room' };
    }
    const safeRole = this._isRole(role) ? role : 'user';
    const safeContent = this._normContent(content);
    if (!safeContent) {
      this.metrics.rejectedMessages++;
      return { ok: false, reason: 'empty_content' };
    }

    this._evictOldestRoomIfNeeded();
    const arr = this.shortTerm.get(rk) || [];
    arr.push({
      id     : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role   : safeRole,
      nick   : String(nick || ''),
      content: safeContent,
      ts     : Number.isFinite(ts) ? ts : Date.now(),
    });
    this.shortTerm.set(rk, arr);
    this.metrics.addedMessages++;

    if (arr.length > this.config.shortTermWindow) {
      const removed = arr.splice(0, arr.length - this.config.shortTermWindow);
      this._maybeCreateSummary(rk, removed);
    }
    return { ok: true };
  }

  _maybeCreateSummary(roomKey, removedMessages) {
    if (!Array.isArray(removedMessages) || removedMessages.length === 0) return;
    if (removedMessages.length < this.config.summaryThreshold) return;

    const topics = this._extractTopics(removedMessages);
    const firstTs = removedMessages[0]?.ts || Date.now();
    const lastTs = removedMessages[removedMessages.length - 1]?.ts || Date.now();
    const summary = {
      ts          : Date.now(),
      messageCount: removedMessages.length,
      firstTs,
      lastTs,
      topics,
      text: `Earlier context: ${removedMessages.length} msgs, topics=${topics.slice(0, 8).join(', ') || 'general chat'}.`,
    };

    const list = this.summaries.get(roomKey) || [];
    list.push(summary);
    if (list.length > this.config.maxSummariesPerRoom) {
      list.splice(0, list.length - this.config.maxSummariesPerRoom);
    }
    this.summaries.set(roomKey, list);
    this.metrics.summariesCreated++;
  }

  _extractTopics(messages) {
    const stop = new Set(['about', 'there', 'their', 'which', 'would', 'could', 'should', 'because', 'thing', 'really', 'where', 'when', 'with', 'that', 'this', 'from', 'have', 'your', 'just', 'what']);
    const counts = new Map();
    for (const m of messages) {
      if (!m?.content) continue;
      const words = String(m.content).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
      for (const w of words) {
        if (w.length < 4 || stop.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([w]) => w);
  }

  getShortTerm(roomKey) {
    const rk = this._normRoomKey(roomKey);
    if (!rk) return [];
    return (this.shortTerm.get(rk) || []).slice();
  }

  getSummaryText(roomKey) {
    const rk = this._normRoomKey(roomKey);
    if (!rk) return null;
    const list = this.summaries.get(rk) || [];
    if (!list.length) return null;
    return list.slice(-3).map(s => s.text).join(' ');
  }

  // ── Profile memory ────────────────────────────────────────────────────────

  putProfile(userKey, memoryKey, value) {
    const uk = this._normUserKey(userKey);
    const mk = String(memoryKey || '').trim();
    if (!uk || !mk) return false;
    if (value === undefined) return false;

    if (!this.profiles.has(uk)) this.profiles.set(uk, new Map());
    const p = this.profiles.get(uk);
    p.set(mk, { value, ts: Date.now() });
    this.metrics.profileWrites++;

    if (p.size > this.config.maxProfileSize) {
      const oldest = p.keys().next().value;
      p.delete(oldest);
      this.metrics.profileEvictions++;
    }
    return true;
  }

  getProfile(userKey, memoryKey, fallback = null) {
    const uk = this._normUserKey(userKey);
    const mk = String(memoryKey || '').trim();
    if (!uk || !mk) return fallback;
    const v = this.profiles.get(uk)?.get(mk);
    if (!v) {
      this.metrics.profileReadMisses++;
      return fallback;
    }
    this.metrics.profileReadHits++;
    return v.value;
  }

  // ── Search helpers ────────────────────────────────────────────────────────

  retrieve({ roomKey, query, limit = 8 }) {
    const rk = this._normRoomKey(roomKey);
    const q = String(query || '').toLowerCase().trim();
    const safeLimit = Math.max(1, Math.min(50, Number.isFinite(limit) ? limit : 8));
    if (!rk || !q) return [];

    const rows = [];
    for (const m of this.shortTerm.get(rk) || []) {
      if (String(m.content).toLowerCase().includes(q)) {
        rows.push({ source: 'short', ts: m.ts, score: 1, content: m.content });
      }
    }
    for (const s of this.summaries.get(rk) || []) {
      if (String(s.text).toLowerCase().includes(q) || s.topics?.some(t => t.includes(q))) {
        rows.push({ source: 'summary', ts: s.ts, score: 0.6, content: s.text });
      }
    }
    return rows.sort((a, b) => (b.score - a.score) || (b.ts - a.ts)).slice(0, safeLimit);
  }

  // ── Maintenance / health ──────────────────────────────────────────────────

  cleanup() {
    // Bounded maps are already enforced; this call is for telemetry + future TTL.
    this.metrics.lastCleanupTs = Date.now();
  }

  snapshot() {
    const shortMsgs = [...this.shortTerm.values()].reduce((s, arr) => s + arr.length, 0);
    const summaryCount = [...this.summaries.values()].reduce((s, arr) => s + arr.length, 0);
    const profileUsers = this.profiles.size;
    const profileEntries = [...this.profiles.values()].reduce((s, m) => s + m.size, 0);
    return {
      config : { ...this.config },
      usage  : { rooms: this.shortTerm.size, shortMsgs, summaryCount, profileUsers, profileEntries },
      metrics: { ...this.metrics },
    };
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  toJSON() {
    const shortTerm = {};
    for (const [k, arr] of this.shortTerm.entries()) shortTerm[k] = arr;
    const summaries = {};
    for (const [k, arr] of this.summaries.entries()) summaries[k] = arr;
    const profiles = {};
    for (const [uk, map] of this.profiles.entries()) {
      profiles[uk] = Object.fromEntries(map.entries());
    }
    return {
      version  : 1,
      shortTerm,
      summaries,
      profiles,
      metrics  : { ...this.metrics },
    };
  }

  fromJSON(raw) {
    if (!raw || typeof raw !== 'object') return;
    this.shortTerm.clear();
    this.summaries.clear();
    this.profiles.clear();

    const st = raw.shortTerm && typeof raw.shortTerm === 'object' ? raw.shortTerm : {};
    for (const [k, arr] of Object.entries(st)) {
      if (!Array.isArray(arr)) continue;
      const safe = arr
        .filter(m => m && typeof m === 'object')
        .map(m => ({
          id: String(m.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          role: this._isRole(m.role) ? m.role : 'user',
          nick: String(m.nick || ''),
          content: this._normContent(String(m.content || '')) || '',
          ts: Number.isFinite(m.ts) ? m.ts : Date.now(),
        }))
        .filter(m => m.content)
        .slice(-this.config.shortTermWindow);
      this.shortTerm.set(k, safe);
    }

    const su = raw.summaries && typeof raw.summaries === 'object' ? raw.summaries : {};
    for (const [k, arr] of Object.entries(su)) {
      if (!Array.isArray(arr)) continue;
      this.summaries.set(k, arr.slice(-this.config.maxSummariesPerRoom));
    }

    const pf = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {};
    for (const [uk, obj] of Object.entries(pf)) {
      if (!obj || typeof obj !== 'object') continue;
      const map = new Map();
      for (const [mk, v] of Object.entries(obj)) {
        map.set(mk, {
          value: v?.value ?? null,
          ts   : Number.isFinite(v?.ts) ? v.ts : Date.now(),
        });
      }
      // bound enforce after restore
      while (map.size > this.config.maxProfileSize) {
        map.delete(map.keys().next().value);
      }
      this.profiles.set(uk, map);
    }

    if (raw.metrics && typeof raw.metrics === 'object') {
      this.metrics = { ...this.metrics, ...raw.metrics };
    }
  }
}

module.exports = TieredMemoryManager;
