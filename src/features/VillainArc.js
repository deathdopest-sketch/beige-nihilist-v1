'use strict';

/**
 * VillainArc — per-user toxicity tracking that produces escalating callouts.
 *
 * Thresholds:
 *   score 3  → "starting to build a reputation"
 *   score 7  → "officially on my list"
 *   score 15 → full villain arc announcement with receipts
 *
 * Provides getPromptLine(username) for AI prompt injection.
 */
class VillainArc {
  constructor() {
    /** @type {Map<string, {toxicityScore, callouts, lastEscalation}>} */
    this._arcs = new Map();
  }

  // ── Feed ──────────────────────────────────────────────────────────────────

  /**
   * Record a toxic signal from a user.
   * @param {string} username  — lowercase key
   * @param {string} content   — the message
   * @param {Function} send    — async (text) to broadcast the announcement
   */
  feed(username, content, send) {
    const key = username.toLowerCase();
    if (!this._arcs.has(key)) {
      this._arcs.set(key, { toxicityScore: 0, callouts: [], lastEscalation: 0 });
    }
    const arc = this._arcs.get(key);
    arc.toxicityScore++;
    arc.callouts.push(content.slice(0, 100));
    if (arc.callouts.length > 10) arc.callouts.shift();

    const now      = Date.now();
    const cooldown = 10 * 60 * 1000;
    if (now - arc.lastEscalation < cooldown) return;

    let msg = null;
    if (arc.toxicityScore === 3) {
      msg = `${key} starting to build a reputation in here. not a good one.`;
    } else if (arc.toxicityScore === 7) {
      msg = `${key} is officially on my list. keeping receipts.`;
    } else if (arc.toxicityScore === 15) {
      const worst = arc.callouts[Math.floor(Math.random() * arc.callouts.length)];
      msg = `${key} villain arc is complete. remember when they said "${worst.slice(0, 60)}"? yeah. logged.`;
    }

    if (msg) {
      arc.lastEscalation = now;
      setTimeout(() => send?.(msg), 3000);
    }
  }

  // ── Prompt injection ──────────────────────────────────────────────────────

  /** Returns a [VILLAIN ARC] context line for the AI prompt, or null. */
  getPromptLine(username) {
    const arc = this._arcs.get(username.toLowerCase());
    if (!arc || arc.toxicityScore < 3) return null;
    const tier   = arc.toxicityScore >= 15 ? 'ARCH NEMESIS' : arc.toxicityScore >= 7 ? 'VILLAIN' : 'TROUBLEMAKER';
    const sample = arc.callouts.slice(-3).join(' | ');
    return `[VILLAIN ARC] ${username} is your ${tier} (toxicity: ${arc.toxicityScore}). Their recent nonsense: "${sample}". You remember all of it. Respond accordingly — not by being a pushover.`;
  }

  // ── Reset ─────────────────────────────────────────────────────────────────

  clear(username) {
    this._arcs.delete(username.toLowerCase());
  }

  getScore(username) {
    return this._arcs.get(username.toLowerCase())?.toxicityScore || 0;
  }
}

module.exports = VillainArc;
