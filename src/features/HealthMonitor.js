'use strict';

/**
 * HealthMonitor — per-room conversation quality metrics.
 *
 * Tracks:
 *   - Blocked replies per reason (junk, prompt_bleed, duplicate, etc.)
 *   - Average reply length per room
 *   - Loop clears per hour
 *   - Global reconnect count
 *   - FreeVoice trigger rate
 *
 * Exposes a snapshot() payload consumed by the /health HTTP endpoint.
 * Logs warnings when any metric crosses configured thresholds.
 */
class HealthMonitor {
  /**
   * @param {Object} logger
   * @param {Object} opts.alertThresholds — optional overrides
   */
  constructor(logger, opts = {}) {
    this.log       = logger;
    this._startMs  = Date.now();

    /** @type {Map<string, RoomStats>} */
    this._rooms    = new Map();

    this._reconnects         = 0;
    this._freeVoiceAttempts  = 0;
    this._freeVoiceTriggers  = 0;

    this._thresholds = {
      blockRatePerHour  : opts.blockRatePerHour   ?? 30,
      avgLengthLow      : opts.avgLengthLow        ?? 12,
      loopClearsPerHour : opts.loopClearsPerHour   ?? 5,
      reconnectsPerHour : opts.reconnectsPerHour   ?? 10,
      ...opts.alertThresholds,
    };

    // Rotate hourly counters every 60 minutes
    this._rotateTimer = setInterval(() => this._rotateBuckets(), 60 * 60_000);
    this._rotateTimer.unref?.();
  }

  // ── Per-room record ───────────────────────────────────────────────────────

  _room(name) {
    if (!this._rooms.has(name)) {
      this._rooms.set(name, {
        name,
        blocked        : {},   // { reason: count } — current hour
        blockedTotal   : {},   // lifetime totals
        replySentCount : 0,
        replyLengthSum : 0,
        loopClears     : 0,    // lifetime
        loopClearsHour : 0,    // current hour
        hourBuckets    : [],   // rolling 24-hour history
      });
    }
    return this._rooms.get(name);
  }

  // ── Recording events ──────────────────────────────────────────────────────

  recordBlocked(room, reason) {
    const r = this._room(room);
    r.blocked[reason]      = (r.blocked[reason]      || 0) + 1;
    r.blockedTotal[reason] = (r.blockedTotal[reason] || 0) + 1;
    this._checkAlerts(room);
  }

  recordReply(room, replyText) {
    const r = this._room(room);
    r.replySentCount++;
    r.replyLengthSum += (replyText?.length || 0);
    this._checkAlerts(room);
  }

  recordLoopClear(room) {
    const r = this._room(room);
    r.loopClears++;
    r.loopClearsHour++;
    this._checkAlerts(room);
  }

  recordReconnect() {
    this._reconnects++;
    const hrs = Math.max((Date.now() - this._startMs) / 3_600_000, 1 / 3600);
    if (this._reconnects / hrs > this._thresholds.reconnectsPerHour) {
      this.log?.warn(`[HealthMonitor] High reconnect rate: ${(this._reconnects / hrs).toFixed(1)}/hr`);
    }
  }

  recordFreeVoice(triggered) {
    this._freeVoiceAttempts++;
    if (triggered) this._freeVoiceTriggers++;
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  snapshot() {
    const uptimeSecs = Math.floor((Date.now() - this._startMs) / 1000);
    const hours = Math.max(uptimeSecs / 3600, 0.001);

    const rooms = {};
    for (const [name, r] of this._rooms) {
      rooms[name] = {
        blocked          : { ...r.blocked },
        blockedTotal     : { ...r.blockedTotal },
        avgReplyLen      : r.replySentCount
          ? Math.round(r.replyLengthSum / r.replySentCount) : 0,
        replySentCount   : r.replySentCount,
        loopClears       : r.loopClears,
        loopClearsPerHour: +(r.loopClears / hours).toFixed(2),
        hourHistory      : r.hourBuckets.slice(-6),  // last 6 hours
      };
    }

    return {
      uptimeSecs,
      reconnects         : this._reconnects,
      reconnectsPerHour  : +(this._reconnects / hours).toFixed(2),
      freeVoiceAttempts  : this._freeVoiceAttempts,
      freeVoiceTriggers  : this._freeVoiceTriggers,
      freeVoiceRate      : this._freeVoiceAttempts
        ? `${(this._freeVoiceTriggers / this._freeVoiceAttempts * 100).toFixed(1)}%` : '0%',
      rooms,
    };
  }

  // ── Alert detection ───────────────────────────────────────────────────────

  _checkAlerts(room) {
    const r   = this._rooms.get(room);
    if (!r) return;
    const hrs = Math.max((Date.now() - this._startMs) / 3_600_000, 1 / 3600);

    const totalBlocked = Object.values(r.blocked).reduce((a, b) => a + b, 0);
    if (totalBlocked / hrs > this._thresholds.blockRatePerHour) {
      this.log?.warn(
        `[HealthMonitor][${room}] High block rate: ${(totalBlocked / hrs).toFixed(1)}/hr`
      );
    }

    if (r.replySentCount >= 5) {
      const avg = r.replyLengthSum / r.replySentCount;
      if (avg < this._thresholds.avgLengthLow) {
        this.log?.warn(
          `[HealthMonitor][${room}] Avg reply length low: ${Math.round(avg)} chars`
        );
      }
    }

    if (r.loopClearsHour / hrs > this._thresholds.loopClearsPerHour) {
      this.log?.warn(
        `[HealthMonitor][${room}] Frequent loop clears: ${r.loopClearsHour} this hour`
      );
    }
  }

  _rotateBuckets() {
    for (const r of this._rooms.values()) {
      r.hourBuckets.push({
        ts          : Date.now(),
        blocked     : { ...r.blocked },
        loopClears  : r.loopClearsHour,
        avgReplyLen : r.replySentCount
          ? Math.round(r.replyLengthSum / r.replySentCount) : 0,
      });
      if (r.hourBuckets.length > 24) r.hourBuckets.shift();

      // Reset hourly counters
      r.blocked        = {};
      r.loopClearsHour = 0;
    }
  }

  destroy() {
    clearInterval(this._rotateTimer);
  }
}

module.exports = HealthMonitor;
