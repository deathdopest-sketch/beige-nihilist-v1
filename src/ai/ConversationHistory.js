'use strict';

/**
 * ConversationHistory — per-room sliding window of recent chat messages
 * fed into Ollama as context.
 *
 * Stores messages as { role: 'user'|'assistant', content, ts, nick } objects.
 * Provides the formatted message array for /api/chat and helpers for
 * dedup / loop detection.
 */
class ConversationHistory {
  /**
   * @param {number} maxMessages  Per-room history cap (default 100)
   * @param {number} maxAgeMs     Drop messages older than this (default 30 min)
   */
  constructor(maxMessages = 100, maxAgeMs = 30 * 60 * 1000) {
    this._maxMessages = maxMessages;
    this._maxAgeMs    = maxAgeMs;
    this._rooms       = new Map(); // roomName → [{ role, content, ts, nick }]
    this._summaries   = new Map(); // roomName → { text, ts }
  }

  // ── Summary storage ───────────────────────────────────────────────────────

  getSummary(roomName) { return this._summaries.get(roomName) || null; }
  setSummary(roomName, text) { this._summaries.set(roomName, { text, ts: Date.now() }); }
  clearSummary(roomName) { this._summaries.delete(roomName); }

  // ── Per-room access ───────────────────────────────────────────────────────

  _get(roomName) {
    if (!this._rooms.has(roomName)) this._rooms.set(roomName, []);
    return this._rooms.get(roomName);
  }

  clear(roomName) {
    this._rooms.set(roomName, []);
  }

  /**
   * Clear default history for a logical room and every persona-scoped bucket
   * `roomName::<personaId>`. Used when pinning or removing a per-room persona.
   */
  clearRoomBundle(baseRoomName) {
    if (!baseRoomName || typeof baseRoomName !== 'string') return;
    const prefix = `${baseRoomName}::`;
    for (const key of [...this._rooms.keys()]) {
      if (key === baseRoomName || key.startsWith(prefix)) {
        this._rooms.delete(key);
        this._summaries.delete(key);
      }
    }
  }

  /**
   * Clear all history buckets for a given persona id across every room
   * (keys ending with `::<personaId>`). Used on global persona switch.
   */
  clearPersonaAcrossRooms(personaId) {
    if (!personaId || typeof personaId !== 'string') return;
    const suffix = `::${personaId}`;
    for (const key of [...this._rooms.keys()]) {
      if (key.endsWith(suffix)) {
        this._rooms.delete(key);
        this._summaries.delete(key);
      }
    }
  }

  /** Drop every persona-isolated bucket; default per-room keys remain. */
  clearAllPersonaScoped() {
    for (const key of [...this._rooms.keys()]) {
      if (key.includes('::')) {
        this._rooms.delete(key);
        this._summaries.delete(key);
      }
    }
  }

  clearAll() {
    this._rooms.clear();
  }

  /**
   * History keys for one logical room: `roomName` plus every `roomName::<personaId>`.
   * @param {string} baseRoomName
   * @returns {string[]}
   */
  keysForLogicalRoom(baseRoomName) {
    if (!baseRoomName || typeof baseRoomName !== 'string') return [];
    const prefix = `${baseRoomName}::`;
    const keys = [];
    for (const k of this._rooms.keys()) {
      if (k === baseRoomName || k.startsWith(prefix)) keys.push(k);
    }
    return keys;
  }

  /**
   * Recent non-command user lines from `nick` across default + persona-scoped buffers.
   * Dedupes near-identical lines (signature prefix).
   * @param {string} baseRoomName
   * @param {string} nick
   * @param {number} [maxLines]
   * @param {number} [maxCharsPerLine]
   * @returns {string[]}
   */
  recentUserLinesAcrossPersonas(baseRoomName, nick, maxLines = 30, maxCharsPerLine = 150) {
    const want = String(nick || '').toLowerCase();
    if (!want) return [];
    const seen = new Set();
    const out = [];
    const keys = this.keysForLogicalRoom(baseRoomName);
    if (keys.length === 0) keys.push(baseRoomName);
    for (const key of keys) {
      for (const m of this._get(key)) {
        if (m.role !== 'user') continue;
        const mn = (m.nick || '').toLowerCase();
        if (mn !== want) continue;
        let body = typeof m.content === 'string' ? m.content : '';
        body = body.replace(/^[^:]+:\s*/, '').trim();
        if (body.startsWith('.')) continue;
        const line = body.slice(0, maxCharsPerLine);
        if (!line) continue;
        const sig = line.slice(0, 72).toLowerCase();
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(line);
        if (out.length >= maxLines) return out;
      }
    }
    return out;
  }

  // ── Adding messages ───────────────────────────────────────────────────────

  addUser(roomName, nick, content) {
    this._add(roomName, { role: 'user', content: `${nick}: ${content}`, nick });
  }

  addAssistant(roomName, content) {
    this._add(roomName, { role: 'assistant', content });
  }

  _add(roomName, entry) {
    const history = this._get(roomName);
    history.push({ ...entry, ts: Date.now() });
    this._prune(roomName);
  }

  _prune(roomName) {
    const history = this._get(roomName);
    const cutoff  = Date.now() - this._maxAgeMs;
    // Age-based prune
    const fresh = history.filter(m => m.ts >= cutoff);
    // Length cap (keep most recent)
    const kept  = fresh.slice(-this._maxMessages);
    this._rooms.set(roomName, kept);
  }

  // ── Building the API message array ────────────────────────────────────────

  /**
   * Return messages ready for Ollama /api/chat.
   * Injects the system prompt as the first message.
   * @param {string} roomName
   * @param {string} systemPrompt
   * @param {string} [extraContext]  Injected before the last user message (e.g. LEARNED: hints)
   * @returns {Array<{role:string, content:string}>}
   */
  buildMessages(roomName, systemPrompt, extraContext) {
    this._prune(roomName);
    const history = this._get(roomName);

    const messages = [{ role: 'system', content: systemPrompt }];

    // Inject rolling summary of older history if available
    const summary = this._summaries.get(roomName);
    if (summary) {
      messages.push({ role: 'system', content: `[EARLIER CONTEXT] ${summary.text}` });
    }

    if (extraContext && history.length > 0) {
      // Inject extra context as a system note before the last user message
      const last = history[history.length - 1];
      for (const m of history.slice(0, -1)) {
        messages.push({ role: m.role, content: m.content });
      }
      messages.push({ role: 'system', content: extraContext });
      messages.push({ role: last.role, content: last.content });
    } else {
      for (const m of history) {
        messages.push({ role: m.role, content: m.content });
      }
    }

    return messages;
  }

  // ── Loop / similarity detection ───────────────────────────────────────────

  /**
   * Detect if the bot has been producing near-identical responses recently.
   * Returns true if the last N assistant messages are >threshold similar.
   */
  isLooping(roomName, windowMs = 2 * 60 * 1000, threshold = 0.7, minCount = 3) {
    const history = this._get(roomName);
    const cutoff  = Date.now() - windowMs;
    const recent  = history.filter(m => m.role === 'assistant' && m.ts >= cutoff);
    if (recent.length < minCount) return false;

    const texts = recent.map(m => new Set(m.content.toLowerCase().split(/\s+/)));
    // Check pairwise overlap for last minCount messages
    const window = texts.slice(-minCount);
    let looping = true;
    for (let i = 1; i < window.length; i++) {
      const a = window[i - 1];
      const b = window[i];
      const intersect = [...a].filter(w => b.has(w)).length;
      const overlap   = intersect / Math.min(a.size, b.size);
      if (overlap < threshold) { looping = false; break; }
    }
    return looping;
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  toJSON() {
    const out = {};
    for (const [room, msgs] of this._rooms) {
      out[room] = msgs;
    }
    return out;
  }

  fromJSON(data) {
    if (!data || typeof data !== 'object') return;
    for (const [room, msgs] of Object.entries(data)) {
      if (Array.isArray(msgs)) this._rooms.set(room, msgs);
    }
  }
}

module.exports = ConversationHistory;
