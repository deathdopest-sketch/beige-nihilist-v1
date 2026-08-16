'use strict';

/**
 * PersonalityDrift — long-term personality shift based on room history.
 *
 * Tracks:
 *  - hostileDays: increments when >10 hostile emotion snapshots/hour
 *  - deepDays:    increments when >5 melancholy/nostalgic/sad/hour
 *  - activeDays:  increments when >30 words logged/hour
 *
 * After 3+ hostile days → shorter, harder responses
 * After 3+ deep days    → more philosophical, weightier
 * After 5+ active days  → quicker on the draw
 *
 * Persists to zomb_drift.json via StorageManager.
 */
class PersonalityDrift {
  /**
   * @param {Object} storage — StorageManager instance
   * @param {Object} logger  — Logger instance
   */
  constructor(storage, logger) {
    this.storage = storage;
    this.log     = logger;

    this._drift = { hostileDays: 0, deepDays: 0, activeDays: 0, lastUpdated: 0 };
  }

  // ── Public getters ────────────────────────────────────────────────────────

  get hostileDays() { return this._drift.hostileDays; }
  get deepDays()    { return this._drift.deepDays; }
  get activeDays()  { return this._drift.activeDays; }

  /**
   * Returns a [DRIFT] system prompt line, or null if no active drift.
   */
  get promptLine() {
    const { hostileDays, deepDays, activeDays } = this._drift;
    if (hostileDays >= 3) return 'The room has been hostile for days. Be harder now — shorter responses, less patience, quicker to cut people off.';
    if (deepDays    >= 3) return 'The room has been getting into dark, heavy topics. Lean into it — brief, blunt dark observations. Stay grounded, don\'t get poetic.';
    if (activeDays  >= 5) return 'High-activity stretch. Stay engaged, quicker on the draw.';
    return null;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  /**
   * Feed current room snapshot. Call once per hour (or after processing a batch of messages).
   * @param {Array} emotionSnapshots — [{ emotion, ts }] from ZomBEmotionalIntelligence
   * @param {Array} wordLog          — [{ words[], ts }] from bot word tracking
   */
  update(emotionSnapshots, wordLog) {
    const now     = Date.now();
    const hourAgo = now - 3600000;

    const hostileCount = (emotionSnapshots || []).filter(s =>
      s.ts > hourAgo && ['angry', 'aggressive', 'frustrated', 'confrontational'].includes(s.emotion)
    ).length;

    const deepCount = (emotionSnapshots || []).filter(s =>
      s.ts > hourAgo && ['melancholy', 'nostalgic', 'sad'].includes(s.emotion)
    ).length;

    const activeCount = (wordLog || []).filter(w => w.ts > hourAgo).length;

    if (hostileCount > 10) this._drift.hostileDays = Math.min(10, this._drift.hostileDays + 1);
    else if (this._drift.hostileDays > 0) this._drift.hostileDays = Math.max(0, this._drift.hostileDays - 0.1);

    if (deepCount > 5) this._drift.deepDays = Math.min(10, this._drift.deepDays + 1);
    else if (this._drift.deepDays > 0) this._drift.deepDays = Math.max(0, this._drift.deepDays - 0.1);

    if (activeCount > 30) this._drift.activeDays = Math.min(10, this._drift.activeDays + 1);
    else if (this._drift.activeDays > 0) this._drift.activeDays = Math.max(0, this._drift.activeDays - 0.2);

    this._drift.lastUpdated = now;
    this._save();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _save() {
    try {
      const fp = require('path').join(
        this.storage.activeDir,
        'zomb_drift.json'
      );
      require('fs').writeFileSync(fp, JSON.stringify(this._drift, null, 2));
    } catch (_) {}
  }

  load() {
    try {
      const fp = require('path').join(
        this.storage.activeDir,
        'zomb_drift.json'
      );
      if (require('fs').existsSync(fp)) {
        this._drift = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
        this.log?.info(`PersonalityDrift loaded — hostile:${this._drift.hostileDays.toFixed(1)}, deep:${this._drift.deepDays.toFixed(1)}, active:${this._drift.activeDays}`);
      }
    } catch (_) {}
  }
}

module.exports = PersonalityDrift;
