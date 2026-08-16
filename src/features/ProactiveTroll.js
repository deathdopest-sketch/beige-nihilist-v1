'use strict';

/**
 * ProactiveTroll — fires unprompted into active conversations.
 *
 * Distinct from ChaosAgent (quiet-room injection) — this fires INTO active
 * conversation, uninvited, like a person who's been watching and finally speaks.
 *
 * Three modes:
 *   observer_drop  — meta-observation about the room dynamic Spackle has been watching
 *   callout        — bring back something specific a user said 3-12 min ago, cold
 *   thread_hijack  — room is hot on a topic; one line that sidewinds it completely
 */

const PROACTIVE_COOLDOWN_MS = 2.5 * 60_000; // 2.5 min — was 4, too rare in active rooms
const ACTIVE_WINDOW_MS      =  2 * 60_000;  // room must have msgs in last 2 min to be eligible
const CALLOUT_MIN_MS        =  3 * 60_000;  // callout target: said it at least 3 min ago
const CALLOUT_MAX_MS        = 12 * 60_000;  // ... and no more than 12 min ago
const HOT_THREAD_MIN_MSGS   = 4;            // require 4+ recent msgs (was 5)
const HOT_THREAD_SPEAKERS   = 2;            // from at least 2 unique speakers (was 3)
const FIRE_CHANCE           = 0.65;         // 65% chance when all gates clear (was 40%)

class ProactiveTroll {
  constructor(log) {
    this._log        = log;
    this._lastFireMs = new Map();  // roomName → timestamp
    this._msgLog     = new Map();  // roomName → [{nick, text, ts}]
  }

  /** Feed every incoming room message so we have context to work from. */
  onMessage(roomName, nick, text) {
    if (!text || !nick) return;
    const log = this._msgLog.get(roomName) || [];
    log.push({ nick, text: text.slice(0, 200), ts: Date.now() });
    if (log.length > 40) log.shift();
    this._msgLog.set(roomName, log);
  }

  /**
   * Call every 90s per room.
   * Returns { should: false } or { should: true, mode, context, hint }
   *
   * @param {string} roomName
   * @param {string} selfNick        — bot's own nick, to exclude from candidate msgs
   * @param {number} silenceUntil    — timestamp from _postTrollSilence (skip if future)
   * @param {number} lastSentMs      — timestamp of last sent message (any kind)
   */
  shouldFire(roomName, selfNick, silenceUntil = 0, lastSentMs = 0) {
    const now = Date.now();

    // Own cooldown
    if (now - (this._lastFireMs.get(roomName) || 0) < PROACTIVE_COOLDOWN_MS) return { should: false };

    // Respect post-troll silence
    if (now < silenceUntil) return { should: false };

    // Minimal breathing room — 5s to avoid literal same-second stacking only.
    // Was 20s which permanently blocked ProactiveTroll in active rooms where regular sends fire every 5-15s.
    // The 2.5-min own cooldown already prevents spam.
    if (now - lastSentMs < 5_000) return { should: false };

    // Room must be actively talking
    const log = this._msgLog.get(roomName) || [];
    const selfLc = (selfNick || '').toLowerCase();
    const recentAll = log.filter(m => now - m.ts < ACTIVE_WINDOW_MS);
    const recent    = recentAll.filter(m => m.nick.toLowerCase() !== selfLc);
    if (recent.length < 4) return { should: false };

    // Probability gate
    if (Math.random() > FIRE_CHANCE) return { should: false };

    const result = this._pickMode(log, recent, now, selfLc);
    if (!result) return { should: false };

    this._lastFireMs.set(roomName, now);
    return { should: true, ...result };
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  _pickMode(log, recent, now, selfLc) {
    // Try callout — most specific, lands hardest
    const calloutTarget = this._findCalloutTarget(log, now, selfLc);
    if (calloutTarget && Math.random() > 0.45) {
      const minAgo = Math.round((now - calloutTarget.ts) / 60_000);
      return {
        mode   : 'callout',
        context: this._buildContext(recent),
        hint   : `PROACTIVE_CALLOUT: You've been quiet but you noticed something. Someone said "${calloutTarget.text.slice(0, 100)}" about ${minAgo} minute${minAgo === 1 ? '' : 's'} ago and nobody followed up. Bring it back — react to the CONTENT, not the person. One short line. Sound like you've been sitting on it.`,
      };
    }

    // Thread hijack if conversation is concentrated and hot
    if (this._isHotThread(recent) && Math.random() > 0.25) {
      // Pull the most recent substantive message to anchor the model to real content
      const anchor = recent.filter(m => m.nick.toLowerCase() !== selfLc && m.text.length > 8).slice(-1)[0];
      const anchorQuote = anchor ? `"${anchor.text.slice(0, 80)}"` : 'what was just said';
      return {
        mode   : 'thread_hijack',
        context: this._buildContext(recent),
        hint   : `PROACTIVE_HIJACK: They just said ${anchorQuote}. React to THAT specific thing — find the most unexpected TRUE angle on the ACTUAL content. NOT a random non-sequitur, NOT abstract words like "brutality" or "fate". React to the literal words above. One line, 6 words max. Deadpan. Commit.`,
      };
    }

    // Observer drop — you've been watching and you have a read
    return {
      mode   : 'observer_drop',
      context: this._buildContext(recent),
      hint   : `PROACTIVE_OBSERVER: You've been watching silently. React to what people are SAYING or DOING — not their names. Names in the context are chat usernames (people), never things to riff on. Drop ONE dry sardonic one-liner about the actual conversation topic. No quotes. UNDER 8 WORDS.`,
    };
  }

  _findCalloutTarget(log, now, selfLc) {
    const candidates = log.filter(m =>
      m.nick.toLowerCase() !== selfLc &&
      now - m.ts >= CALLOUT_MIN_MS &&
      now - m.ts <= CALLOUT_MAX_MS &&
      m.text.length >= 12 &&
      !m.text.startsWith('.') &&
      !/^https?:\/\//i.test(m.text)
    );
    if (!candidates.length) return null;
    // Prefer longer messages — more substance to call back
    candidates.sort((a, b) => b.text.length - a.text.length);
    return candidates[0];
  }

  _isHotThread(recent) {
    if (recent.length < HOT_THREAD_MIN_MSGS) return false;
    const speakers = new Set(recent.map(m => m.nick));
    return speakers.size >= HOT_THREAD_SPEAKERS;
  }

  _buildContext(msgs) {
    return msgs.slice(-12).map(m => `${m.nick}: ${m.text}`).join('\n');
  }
}

module.exports = ProactiveTroll;
