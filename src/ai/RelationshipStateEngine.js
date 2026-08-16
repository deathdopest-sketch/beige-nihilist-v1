'use strict';

/**
 * RelationshipStateEngine
 * - Tracks room/user conversational progression
 * - Emits signal hints for context injection (never overwrites persona voice)
 */
class RelationshipStateEngine {
  constructor(config = {}) {
    this.config = {
      maxUsersPerRoom: Number.isFinite(config.maxUsersPerRoom) ? Math.max(20, Math.min(500, config.maxUsersPerRoom)) : 120,
      maxTopicsPerUser: Number.isFinite(config.maxTopicsPerUser) ? Math.max(3, Math.min(40, config.maxTopicsPerUser)) : 10,
      decayMs: Number.isFinite(config.decayMs) ? Math.max(10 * 60_000, config.decayMs) : 6 * 60 * 60_000,
      ...config,
    };
    // room -> user -> state
    this._rooms = new Map();
  }

  _room(room) {
    if (!this._rooms.has(room)) this._rooms.set(room, new Map());
    return this._rooms.get(room);
  }

  _userState(room, user) {
    const rm = this._room(room);
    if (!rm.has(user)) {
      rm.set(user, {
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        messages: 0,
        questions: 0,
        depth: 0,
        relationship: 'new', // new | familiar | trusted
        topics: new Map(), // topic -> count
      });
      this._boundRoom(room);
    }
    return rm.get(user);
  }

  observe({ room, user, text }) {
    const rk = String(room || '').trim();
    const uk = String(user || '').trim().toLowerCase();
    const msg = typeof text === 'string' ? text.trim() : '';
    if (!rk || !uk || !msg) return;

    const s = this._userState(rk, uk);
    s.lastSeen = Date.now();
    s.messages++;
    if (/\?/.test(msg)) s.questions++;
    s.depth = this._estimateDepth(msg, s.depth);
    s.relationship = this._relationshipBand(s);
    this._extractTopics(msg, s.topics);
    this._boundTopics(s.topics);
  }

  getSignals(room, user) {
    const rk = String(room || '').trim();
    const uk = String(user || '').trim().toLowerCase();
    if (!rk || !uk) return null;
    const s = this._room(rk).get(uk);
    if (!s) return null;
    const age = Date.now() - s.lastSeen;
    if (age > this.config.decayMs) {
      // Soft decay for stale relationships.
      const decayed = { ...s, relationship: 'new', depth: Math.max(0, Math.floor(s.depth * 0.5)) };
      return this._signalLine(decayed);
    }
    return this._signalLine(s);
  }

  _signalLine(s) {
    const topTopics = [...s.topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t).join(', ');
    return {
      relationship: s.relationship,
      depth: s.depth,
      topicHint: topTopics || null,
      line: `REL_STATE: ${s.relationship} | depth=${s.depth}${topTopics ? ` | topics=${topTopics}` : ''}`,
    };
  }

  _relationshipBand(s) {
    if (s.messages >= 40) return 'trusted';
    if (s.messages >= 12) return 'familiar';
    return 'new';
  }

  _estimateDepth(text, current) {
    let d = current || 0;
    if (/\b(why|how|because|feel|think|explain|meaning|belief|purpose)\b/i.test(text)) d += 2;
    if (/\b(hi|hey|yo|sup|lol|lmao)\b/i.test(text)) d = Math.max(0, d - 1);
    if (text.length > 160) d += 1;
    return Math.max(0, Math.min(10, d));
  }

  _extractTopics(text, topicMap) {
    const words = String(text).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    for (const w of words) {
      if (w.length < 4) continue;
      topicMap.set(w, (topicMap.get(w) || 0) + 1);
    }
  }

  _boundTopics(topicMap) {
    if (topicMap.size <= this.config.maxTopicsPerUser) return;
    const sorted = [...topicMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.config.maxTopicsPerUser);
    topicMap.clear();
    for (const [k, v] of sorted) topicMap.set(k, v);
  }

  _boundRoom(room) {
    const rm = this._room(room);
    if (rm.size <= this.config.maxUsersPerRoom) return;
    const sorted = [...rm.entries()].sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
    const drop = rm.size - this.config.maxUsersPerRoom;
    for (let i = 0; i < drop; i++) rm.delete(sorted[i][0]);
  }

  snapshot() {
    const rooms = {};
    for (const [room, users] of this._rooms.entries()) {
      rooms[room] = { users: users.size };
    }
    return { config: { ...this.config }, rooms };
  }

  toJSON() {
    const out = {};
    for (const [room, users] of this._rooms.entries()) {
      out[room] = {};
      for (const [user, s] of users.entries()) {
        out[room][user] = {
          ...s,
          topics: Object.fromEntries(s.topics.entries()),
        };
      }
    }
    return { version: 1, rooms: out };
  }

  fromJSON(raw) {
    if (!raw || typeof raw !== 'object' || !raw.rooms) return;
    this._rooms.clear();
    for (const [room, usersObj] of Object.entries(raw.rooms)) {
      const users = new Map();
      if (!usersObj || typeof usersObj !== 'object') continue;
      for (const [user, s] of Object.entries(usersObj)) {
        users.set(user, {
          firstSeen: Number.isFinite(s?.firstSeen) ? s.firstSeen : Date.now(),
          lastSeen : Number.isFinite(s?.lastSeen) ? s.lastSeen : Date.now(),
          messages : Number.isFinite(s?.messages) ? s.messages : 0,
          questions: Number.isFinite(s?.questions) ? s.questions : 0,
          depth    : Number.isFinite(s?.depth) ? s.depth : 0,
          relationship: typeof s?.relationship === 'string' ? s.relationship : 'new',
          topics: new Map(Object.entries(s?.topics || {})),
        });
      }
      this._rooms.set(room, users);
    }
  }
}

module.exports = RelationshipStateEngine;
