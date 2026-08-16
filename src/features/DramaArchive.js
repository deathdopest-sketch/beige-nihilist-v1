'use strict';

/**
 * DramaArchive — long-term room drama memory.
 *
 * Extends EpisodicMemory with room drama tagging.
 * Spackle can reference old drama to stir things up.
 *
 * Drama types: argument | ban | meltdown | friendship | romance | callout | chaos
 */

const path = require('path');
const fs   = require('fs');

const MAX_EVENTS_PER_ROOM = 100;
const SAVE_DELAY          = 20_000;

const DRAMA_TRIGGERS = {
  argument:   /\b(fight|argue|wrong|shut up|idiot|stupid|moron|gtfo|blocked|unblock)\b/i,
  meltdown:   /(\b(i hate|fuck you|you're dead|im leaving|this place|goodbye forever|ban me|kick me)\b|[!?!?]{4,})/i,
  callout:    /\b(bot|ai|robot|fake|not real|you're not|you aren't)\b/i,
  romance:    /\b(love you|i like you|you're cute|date me|marry me|kiss me|hot|sexy)\b/i,
  friendship: /\b(you're cool|i like this guy|solid|good chat|appreciate you|respect)\b/i,
  chaos:      /\b(ban|kick|muted|room drama|mod abuse|mass ban|drama)\b/i,
};

class DramaArchive {
  constructor(dataDir) {
    this._path  = path.join(dataDir, 'drama_archive.json');
    this._data  = {};   // roomName → DramaEvent[]
    this._dirty = false;
    this._saveTimer = null;
    this._load();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this._path)) {
        this._data = JSON.parse(fs.readFileSync(this._path, 'utf8'));
      }
    } catch (_) {
      this._data = {};
    }
  }

  _scheduleSave() {
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        this._flush();
      }, SAVE_DELAY);
    }
  }

  _flush() {
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), 'utf8');
      this._dirty = false;
    } catch (_) {}
  }

  flushSync() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this._flush();
  }

  // ── Drama detection ──────────────────────────────────────────────────────────

  /**
   * Scan a message and auto-detect drama type. Returns null if no drama detected.
   */
  detectType(text) {
    for (const [type, re] of Object.entries(DRAMA_TRIGGERS)) {
      if (re.test(text)) return type;
    }
    return null;
  }

  /**
   * Record a drama event.
   * @param {string} roomName
   * @param {string} nick - who caused it
   * @param {string} text - the message
   * @param {string} type - drama type (auto-detected if not provided)
   */
  record(roomName, nick, text, type = null) {
    const dramaType = type || this.detectType(text);
    if (!dramaType) return;

    if (!this._data[roomName]) this._data[roomName] = [];
    const events = this._data[roomName];

    if (events.length >= MAX_EVENTS_PER_ROOM) events.shift();

    events.push({
      ts:   Date.now(),
      nick,
      text: text.slice(0, 200),
      type: dramaType,
    });

    this._dirty = true;
    this._scheduleSave();
  }

  // ── Retrieval ────────────────────────────────────────────────────────────────

  /**
   * Get recent drama events for a room.
   * @returns {Array}
   */
  getRecent(roomName, limit = 5) {
    const events = this._data[roomName] || [];
    return events.slice(-limit);
  }

  /**
   * Get drama involving a specific nick.
   */
  getByNick(roomName, nick, limit = 5) {
    const events = this._data[roomName] || [];
    return events
      .filter(e => e.nick?.toLowerCase() === nick.toLowerCase())
      .slice(-limit);
  }

  /**
   * Get drama of a specific type.
   */
  getByType(roomName, type, limit = 5) {
    const events = this._data[roomName] || [];
    return events.filter(e => e.type === type).slice(-limit);
  }

  /**
   * Whether there has been notable drama recently (within the last N minutes).
   */
  hasRecentDrama(roomName, windowMs = 15 * 60_000) {
    const events = this._data[roomName] || [];
    const cutoff = Date.now() - windowMs;
    return events.some(e => e.ts > cutoff && ['argument','meltdown','chaos'].includes(e.type));
  }

  /**
   * Build an AI context string summarising recent drama.
   * Spackle uses this to reference old events.
   */
  buildContext(roomName, limit = 3) {
    const events = this.getRecent(roomName, limit);
    if (!events.length) return '';
    const lines = events.map(e => {
      const mins = Math.round((Date.now() - e.ts) / 60_000);
      const ago = mins < 60 ? `${mins}m ago` : `${Math.round(mins/60)}h ago`;
      return `[${e.type}] ${e.nick}: "${e.text.slice(0, 80)}" (${ago})`;
    });
    return `Recent room drama:\n${lines.join('\n')}`;
  }

  /**
   * Pick a random memorable drama event to reference (for ChaosAgent).
   * Excludes events older than 6 hours.
   */
  pickForReference(roomName) {
    const cutoff = Date.now() - 6 * 60 * 60_000;
    const events = (this._data[roomName] || []).filter(e =>
      e.ts > cutoff && ['argument','meltdown','callout','chaos'].includes(e.type)
    );
    if (!events.length) return null;
    return events[Math.floor(Math.random() * events.length)];
  }

  allRooms() {
    return Object.keys(this._data);
  }
}

module.exports = DramaArchive;
