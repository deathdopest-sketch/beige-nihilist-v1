'use strict';

/**
 * TrollLedger — persistent per-user troll history.
 *
 * Extends the concept of UserProfiles with troll-specific fields:
 *   troll_score:        float 0–1, how trollable this person is (learned over time)
 *   emotional_triggers: string[] — topics/patterns that set them off
 *   defenses:           string[] — how they tend to avoid trolls
 *   times_called_out:   number — how many times they've called Spackle a bot/troll
 *   successful_trolls:  number — trolls that visibly landed
 *   relationship:       'target' | 'ally' | 'immune' | 'protected' | 'unknown'
 *   last_troll_ts:      number — unix ms
 *   memorable_moments:  Array<{ts, text, technique, outcome}> — capped at 20
 *   escalation_history: Array<{ts, level}> — last 10
 */

const path = require('path');
const fs   = require('fs');

const MAX_MOMENTS  = 20;
const MAX_HISTORY  = 10;
const MAX_QUOTES   = 15;
const SAVE_DELAY   = 15_000;

class TrollLedger {
  constructor(dataDir) {
    this._path  = path.join(dataDir, 'troll_ledger.json');
    this._data  = {};      // username.toLowerCase() → UserTrollRecord
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
    if (this._dirty && !this._saveTimer) {
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

  // ── Profile management ───────────────────────────────────────────────────────

  _ensure(nick) {
    const key = nick.toLowerCase();
    if (!this._data[key]) {
      this._data[key] = {
        nick_display:        nick,
        troll_score:         0.3,
        emotional_triggers:  [],
        defenses:            [],
        times_called_out:    0,
        successful_trolls:   0,
        relationship:        'unknown',
        last_troll_ts:       null,
        memorable_moments:   [],
        escalation_history:  [],
        recent_quotes:       [],   // rolling buffer of verbatim quotes for weaponization
        attacks_on_spackle:  0,    // hostile messages aimed directly at Spackle
        bully_level:         0,    // 0-5, rises with attacks, drives technique selection
        first_seen:          Date.now(),
        last_seen:           Date.now(),
      };
    }
    this._data[key].last_seen = Date.now();
    return this._data[key];
  }

  getProfile(nick) {
    return this._data[nick.toLowerCase()] || null;
  }

  setRelationship(nick, rel) {
    const p = this._ensure(nick);
    p.relationship = rel;
    this._dirty = true;
    this._scheduleSave();
  }

  // ── Event recording ──────────────────────────────────────────────────────────

  recordEvent(nick, technique, score, outcome = 'unknown') {
    const p = this._ensure(nick);

    // Update troll score: moving average weighted toward recent events
    const landed = outcome === 'landed' || outcome === 'unknown';
    p.troll_score = Math.min(1, p.troll_score * 0.85 + (landed ? score / 10 : 0) * 0.15);

    if (outcome === 'landed') p.successful_trolls++;

    p.last_troll_ts = Date.now();

    if (p.memorable_moments.length >= MAX_MOMENTS) p.memorable_moments.shift();
    p.memorable_moments.push({ ts: Date.now(), technique, score, outcome });

    this._dirty = true;
    this._scheduleSave();
  }

  /**
   * Record a direct hostile message aimed at Spackle by name.
   * Escalates bully_level and auto-targets chronic attackers.
   */
  recordAttack(nick) {
    const p = this._ensure(nick);
    p.attacks_on_spackle = (p.attacks_on_spackle || 0) + 1;
    // Escalate bully level (caps at 5)
    p.bully_level = Math.min(5, Math.ceil(p.attacks_on_spackle / 2));
    // Auto-target after 2 attacks
    if (p.attacks_on_spackle >= 2 && p.relationship !== 'protected' && p.relationship !== 'ally') {
      p.relationship = 'target';
    }
    if (!p.defenses.includes('direct_aggression')) {
      p.defenses.push('direct_aggression');
    }
    this._dirty = true;
    this._scheduleSave();
  }

  /** Returns true if this user qualifies as an active bully (3+ attacks on Spackle). */
  isBully(nick) {
    const p = this.getProfile(nick);
    return !!p && (p.attacks_on_spackle || 0) >= 3;
  }

  /** Returns bully_level 0-5 for this user. */
  getBullyLevel(nick) {
    const p = this.getProfile(nick);
    return p?.bully_level || 0;
  }

  recordCallout(nick) {
    const p = this._ensure(nick);
    p.times_called_out = (p.times_called_out || 0) + 1;

    // Repeated callouts suggest immunity is growing
    if (p.times_called_out >= 5 && p.relationship === 'target') {
      p.relationship = 'immune';
    }

    // Track that they detected the troll — add to defenses
    if (!p.defenses.includes('calls_out_bots')) {
      p.defenses.push('calls_out_bots');
    }

    this._dirty = true;
    this._scheduleSave();
  }

  addTrigger(nick, trigger) {
    const p = this._ensure(nick);
    if (!p.emotional_triggers.includes(trigger)) {
      p.emotional_triggers.push(trigger);
      if (p.emotional_triggers.length > 10) p.emotional_triggers.shift();
      this._dirty = true;
      this._scheduleSave();
    }
  }

  // ── Quote weaponization ──────────────────────────────────────────────────────

  /** Store a verbatim quote from a user for later weaponization. */
  storeQuote(nick, text) {
    if (!text || text.length < 20) return;
    const p = this._ensure(nick);
    if (!p.recent_quotes) p.recent_quotes = [];
    p.recent_quotes.push({ text: text.slice(0, 200), ts: Date.now() });
    if (p.recent_quotes.length > MAX_QUOTES) p.recent_quotes.shift();
    this._dirty = true;
    this._scheduleSave();
  }

  /**
   * Return a weapon quote for this user — the most provocative stored quote
   * that isn't too fresh (>60s old so it feels like "you said that earlier").
   * Returns a string or null.
   */
  getWeaponQuote(nick) {
    const p = this.getProfile(nick);
    if (!p?.recent_quotes?.length) return null;
    const now = Date.now();
    // Filter: at least 60s old, not too old (< 90 min)
    const candidates = p.recent_quotes.filter(q =>
      (now - q.ts) > 60_000 && (now - q.ts) < 90 * 60_000
    );
    if (!candidates.length) return null;
    // Pick the longest one — longer quotes tend to be more specific and weaponizable
    candidates.sort((a, b) => b.text.length - a.text.length);
    return candidates[0].text;
  }

  addDefense(nick, defense) {
    const p = this._ensure(nick);
    if (!p.defenses.includes(defense)) {
      p.defenses.push(defense);
      if (p.defenses.length > 8) p.defenses.shift();
      this._dirty = true;
      this._scheduleSave();
    }
  }

  addMemorableMoment(nick, text, technique, outcome = 'unknown') {
    const p = this._ensure(nick);
    if (p.memorable_moments.length >= MAX_MOMENTS) p.memorable_moments.shift();
    p.memorable_moments.push({ ts: Date.now(), text, technique, outcome });
    this._dirty = true;
    this._scheduleSave();
  }

  recordEscalation(nick, level) {
    const p = this._ensure(nick);
    if (p.escalation_history.length >= MAX_HISTORY) p.escalation_history.shift();
    p.escalation_history.push({ ts: Date.now(), level });
    this._dirty = true;
    this._scheduleSave();
  }

  /** Returns a short string of context about a user to inject into the AI prompt. */
  formatContext(nick) {
    const p = this.getProfile(nick);
    if (!p) return '';
    const lines = [];
    if (p.relationship && p.relationship !== 'unknown') lines.push(`Relationship: ${p.relationship}`);
    if (p.troll_score > 0.6)                           lines.push(`Highly trollable (score: ${p.troll_score.toFixed(2)})`);
    if (p.emotional_triggers.length)                   lines.push(`Triggers: ${p.emotional_triggers.slice(-3).join(', ')}`);
    if (p.successful_trolls > 0)                       lines.push(`${p.successful_trolls} successful trolls`);
    if (p.times_called_out > 0)                        lines.push(`Called you out ${p.times_called_out}x`);
    if ((p.attacks_on_spackle || 0) >= 3)              lines.push(`BULLY: ${p.attacks_on_spackle} direct attacks on you (bully_level=${p.bully_level})`);
    else if ((p.attacks_on_spackle || 0) > 0)          lines.push(`${p.attacks_on_spackle} direct attack(s) on you`);
    if (p.memorable_moments.length > 0) {
      const last = p.memorable_moments[p.memorable_moments.length - 1];
      if (last.text) lines.push(`Last memorable moment: "${last.text.slice(0, 80)}"`);
    }
    return lines.join(' | ');
  }

  allProfiles() {
    return Object.values(this._data);
  }
}

module.exports = TrollLedger;
