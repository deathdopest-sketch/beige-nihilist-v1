'use strict';

/**
 * DeathLogger — comprehensive corpus builder for the future Death bot.
 *
 * Output: ZomB_Data/death_corpus.jsonl  (one JSON record per line)
 *
 * Captures every dimension of Death's presence:
 *
 *   message       — room message with full conversation context
 *   command       — .command messages with args parsed out
 *   pvt_message   — private messages Death sends to ZomB
 *   nick_change   — alias switches (death→killaken etc.)
 *   session_start — when Death joins a room
 *   session_end   — when Death leaves, includes duration + message count
 *
 * Each message/command record includes:
 *   context[]   — up to 8 prior messages (BOTH user AND bot replies, with speaker identity)
 *                 This is the "input" side of training pairs.
 *   flags{}     — is_reaction, is_question, is_burst, has_emoji, has_profanity,
 *                 caps_heavy, addressed_to, word_count, char_count
 *   meta{}      — sentiment, cmd/args (if command)
 *   time{}      — hour, day_of_week, time_bucket (morning/afternoon/evening/latenight)
 *   session_id  — links all messages in one presence window
 */

const fs   = require('fs');
const path = require('path');

class DeathLogger {
  /**
   * @param {string}  dataDir   — directory for corpus file (ZomB_Data)
   * @param {Object}  history   — ConversationHistory instance
   * @param {Object}  identity  — IdentitySystem instance (labels context speakers)
   * @param {Object}  logger    — Logger instance
   */
  constructor(dataDir, history, identity, logger) {
    this._history  = history;
    this._identity = identity;
    this.log       = logger;

    this._corpusPath = path.join(dataDir, 'death_corpus.jsonl');
    this._stream     = null;
    this._lineCount  = 0;

    // Burst detection: last Death message timestamp per room
    this._lastMsgTs = new Map();

    // Session tracking: room → { id, nick, startTs, msgCount }
    this._sessions = new Map();

    // Milestone PM callback — set by ZomBBot after construction
    this._onMilestone = null;

    this._openStream();
  }

  // ── Stream lifecycle ──────────────────────────────────────────────────────

  _openStream() {
    try {
      this._stream = fs.createWriteStream(this._corpusPath, { flags: 'a' });
      this._stream.on('error', (e) => {
        this.log?.warn(`[DeathLogger] Stream error: ${e.message}`);
        this._stream = null;
      });
      this.log?.info(`[DeathLogger] Corpus stream open: ${this._corpusPath}`);
    } catch (e) {
      this.log?.warn(`[DeathLogger] Failed to open corpus stream: ${e.message}`);
    }
  }

  close() {
    try { this._stream?.end(); } catch (_) {}
    this._stream = null;
  }

  // ── Milestone callback ────────────────────────────────────────────────────

  /** ZomBBot calls this after construction to wire in the PM notification. */
  setMilestoneCallback(fn) {
    this._onMilestone = fn;
  }

  // ── Session management ────────────────────────────────────────────────────

  startSession(roomName, nick, handle) {
    const id = `${roomName}_${Date.now()}`;
    this._sessions.set(roomName, { id, nick, handle, startTs: Date.now(), msgCount: 0 });
    this._write({
      event      : 'session_start',
      room       : roomName,
      session_id : id,
      nick,
      handle     : handle ? String(handle) : null,
      time       : this._timeInfo(),
    });
  }

  endSession(roomName, nick, handle) {
    const sess = this._sessions.get(roomName);
    if (!sess) {
      // No session tracked — still log the leave event
      this._write({ event: 'session_end', room: roomName, nick, handle: handle ? String(handle) : null, time: this._timeInfo() });
      return;
    }
    const duration_s = Math.round((Date.now() - sess.startTs) / 1000);
    this._write({
      event               : 'session_end',
      room                : roomName,
      session_id          : sess.id,
      nick,
      handle              : handle ? String(handle) : null,
      duration_s,
      messages_in_session : sess.msgCount,
      time                : this._timeInfo(),
    });
    this._sessions.delete(roomName);
  }

  // ── Core logging ──────────────────────────────────────────────────────────

  /**
   * Log a room message or command from Death.
   */
  logMessage(roomName, nick, handle, text) {
    const trimmed = text.trim();
    const isCmd   = trimmed.startsWith('.');

    const sess = this._sessions.get(roomName);
    if (sess) sess.msgCount++;

    const now    = Date.now();
    const lastTs = this._lastMsgTs.get(roomName) || 0;
    const isBurst = (now - lastTs) < 15_000;
    this._lastMsgTs.set(roomName, now);

    // Parse command parts if applicable
    let cmdMeta = null;
    if (isCmd) {
      const parts = trimmed.slice(1).split(/\s+/);
      cmdMeta = { cmd: parts[0]?.toLowerCase() || '', args: parts.slice(1) };
    }

    this._writeMsg({
      event      : isCmd ? 'command' : 'message',
      room       : roomName,
      session_id : sess?.id || null,
      nick,
      handle     : handle ? String(handle) : null,
      text       : trimmed,
      context    : this._getContext(roomName, nick),
      flags      : this._flags(trimmed, isBurst),
      meta       : { ...this._meta(trimmed), ...(cmdMeta || {}) },
      time       : this._timeInfo(),
    });
  }

  /**
   * Log a private message Death sent to ZomB.
   */
  logPvtMessage(roomName, nick, handle, text) {
    const trimmed = text.trim();
    const isCmd   = trimmed.startsWith('.');
    let cmdMeta   = null;
    if (isCmd) {
      const parts = trimmed.slice(1).split(/\s+/);
      cmdMeta = { cmd: parts[0]?.toLowerCase() || '', args: parts.slice(1) };
    }

    this._writeMsg({
      event      : 'pvt_message',
      room       : roomName,
      session_id : this._sessions.get(roomName)?.id || null,
      nick,
      handle     : handle ? String(handle) : null,
      text       : trimmed,
      context    : [],   // PMs are private — no room context to include
      flags      : this._flags(trimmed, false),
      meta       : { ...this._meta(trimmed), ...(cmdMeta || {}) },
      time       : this._timeInfo(),
    });
  }

  /**
   * Log a nick change (alias switch).
   */
  logNickChange(roomName, oldNick, newNick, handle) {
    this._write({
      event      : 'nick_change',
      room       : roomName,
      session_id : this._sessions.get(roomName)?.id || null,
      nick       : newNick,
      old_nick   : oldNick,
      handle     : handle ? String(handle) : null,
      time       : this._timeInfo(),
    });
  }

  // ── Context window ────────────────────────────────────────────────────────

  /**
   * Pull the 8 most recent messages before Death's turn — including ZomB's replies.
   *
   * This is the critical "input" side of training pairs. If Death is reacting to
   * something ZomB said, that ZomB message MUST appear in context or the pair is useless.
   *
   * Each entry: { speaker, role ('user'|'bot'), identity (known name or null), text }
   */
  _getContext(roomName, deathNick) {
    try {
      const hist       = this._history._get(roomName);
      const lowerNick  = deathNick.toLowerCase();
      const ctx        = [];

      for (let i = hist.length - 1; i >= 0 && ctx.length < 8; i--) {
        const m = hist[i];
        if (!m) continue;

        if (m.role === 'assistant') {
          // ZomB's own reply — include it, labelled as bot
          ctx.unshift({
            speaker  : 'ZomBv666',
            role     : 'bot',
            identity : 'ZomBv666',
            text     : m.content,
          });

        } else if (m.role === 'user') {
          const mNick = (m.nick || '').toLowerCase();
          if (mNick === lowerNick) continue;   // skip Death's own prior turns in context

          // Strip "nick: " prefix that ConversationHistory adds
          const speakerText = m.content.replace(/^[^:]+:\s*/, '');
          // Resolve known identity (Lilly, Hippins etc.) for richer training signal
          const { identity } = this._identity.identify(m.nick || '', null);

          ctx.unshift({
            speaker  : m.nick || 'unknown',
            role     : 'user',
            identity : identity || null,
            text     : speakerText,
          });
        }
      }

      return ctx;
    } catch (_) {
      return [];
    }
  }

  // ── Flags ─────────────────────────────────────────────────────────────────

  _flags(text, isBurst) {
    if (!text) return {};
    const t     = text.trim();
    const words = t.split(/\s+/).filter(Boolean);

    return {
      is_reaction   : words.length <= 4,
      is_question   : /\?/.test(t) || /^(what|who|where|when|why|how|can you|do you|are you|is there|tell me)\b/i.test(t),
      is_burst      : isBurst,
      has_url       : /https?:\/\//i.test(t),
      has_emoji     : /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\uD83C[\uDF00-\uDFFF]|\uD83D[\uDC00-\uDE4F]/u.test(t),
      has_profanity : /\b(fuck|shit|cunt|ass\b|bitch|damn|piss|cock|dick|bastard|crap)\b/i.test(t),
      caps_heavy    : t.length > 4 && (t.match(/[A-Z]/g) || []).length / t.length > 0.5,
      addressed_to  : this._detectAddressed(t),
      word_count    : words.length,
      char_count    : t.length,
    };
  }

  /**
   * Detect if Death is directly addressing someone.
   * Covers: "nick: text", "nick, text", "@nick text", "hey nick "
   */
  _detectAddressed(text) {
    const m = text.match(/^(?:@|hey\s+)?([A-Za-z0-9_]{2,20})[,:]\s/i);
    return m ? m[1].toLowerCase() : null;
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  _meta(text) {
    if (!text) return {};
    return { sentiment: this._sentiment(text) };
  }

  _sentiment(text) {
    const pos = /\b(good|great|nice|love|lol|haha|yes|yep|yeah|perfect|awesome|sick|fire|lit|based|kek|funny|legend|lmao|quality|based)\b/i;
    const neg = /\b(shit|fuck|hate|no|nope|wrong|bad|stupid|idiot|nah|wtf|dumb|trash|boring|annoying|cringe|weak)\b/i;
    if (pos.test(text) && !neg.test(text)) return 'positive';
    if (neg.test(text) && !pos.test(text)) return 'negative';
    return 'neutral';
  }

  // ── Time info ─────────────────────────────────────────────────────────────

  _timeInfo() {
    const d = new Date();
    const h = d.getHours();
    return {
      hour        : h,
      day_of_week : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
      time_bucket : h < 6 ? 'latenight' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening',
    };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  _writeMsg(record) {
    this._write(record);
    this._lineCount++;

    // Milestone notification every 1000 messages
    if (this._lineCount % 1000 === 0 && this._onMilestone) {
      try { this._onMilestone(this._lineCount); } catch (_) {}
    }
  }

  _write(record) {
    if (!this._stream) this._openStream();
    if (!this._stream) return;
    try {
      const line = JSON.stringify({
        ts   : Date.now(),
        date : new Date().toISOString(),
        ...record,
      });
      this._stream.write(line + '\n');
    } catch (e) {
      this.log?.warn(`[DeathLogger] Write failed: ${e.message}`);
    }
  }

  get lineCount() { return this._lineCount; }
}

module.exports = DeathLogger;
