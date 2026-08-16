'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * NemesisMemory — persistent record of every Spackle interaction.
 *
 * Reads/writes Beige_Data/nemesis_history.json.
 * Pre-seeded with 4 lore moments at install time.
 *
 * Each record:
 *   { ts, type, room, spackleNick, outcome, summary, beige_score, spackle_score }
 *
 * Types: alliance, defeat, victory, mutual_failure, counter, jab, silence
 * Outcomes: beige_win, spackle_win, mutual_win, draw
 */

const MAX_RECORDS = 500;

class NemesisMemory {
  constructor(dataDir, log) {
    this._path   = path.join(dataDir, 'nemesis_history.json');
    this._log    = log;
    this._records = [];
    this._dirty   = false;
    this._load();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Record a new nemesis interaction. */
  record(type, roomName, spackleNick, outcome, summary, beigeScore = 0, spackleScore = 0) {
    const entry = {
      ts         : Date.now(),
      type,
      room       : roomName,
      spackleNick,
      outcome,
      summary    : (summary || '').slice(0, 300),
      beige_score: beigeScore,
      spackle_score: spackleScore,
    };
    this._records.push(entry);
    if (this._records.length > MAX_RECORDS) {
      this._records = this._records.slice(-MAX_RECORDS);
    }
    this._dirty = true;
    this._log?.debug?.(`[NemesisMemory] Recorded: ${type} / ${outcome} in ${roomName}`);
    return entry;
  }

  /** Get the last N records, optionally filtered by type. */
  recent(n = 10, type = null) {
    let records = this._records;
    if (type) records = records.filter(r => r.type === type);
    return records.slice(-n);
  }

  /** Get Beige's win/loss score vs Spackle. */
  getScore() {
    let beige = 0, spackle = 0;
    for (const r of this._records) {
      beige   += r.beige_score   || 0;
      spackle += r.spackle_score || 0;
    }
    return { beige, spackle, total: this._records.length };
  }

  /** Pick a memorable past interaction to reference in conversation. */
  pickForReference(roomName) {
    const candidates = this._records.filter(r =>
      Date.now() - r.ts > 10 * 60_000 &&    // at least 10 min old
      r.summary && r.summary.length > 10 &&
      (!roomName || r.room === roomName || Math.random() > 0.7)
    );
    if (!candidates.length) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** Save to disk. Called by BeigeBot's save cycle. */
  save() {
    if (!this._dirty) return;
    try {
      fs.writeFileSync(this._path, JSON.stringify(this._records, null, 2), 'utf8');
      this._dirty = false;
    } catch (e) {
      this._log?.warn?.(`[NemesisMemory] Save failed: ${e.message}`);
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, 'utf8');
        const data = JSON.parse(raw);
        this._records = Array.isArray(data) ? data : [];
        this._log?.info?.(`[NemesisMemory] Loaded ${this._records.length} records from ${this._path}`);
      } else {
        this._records = [];
        this._log?.info?.('[NemesisMemory] No history file — starting fresh');
      }
    } catch (e) {
      this._log?.warn?.(`[NemesisMemory] Load failed: ${e.message}`);
      this._records = [];
    }
  }
}

module.exports = NemesisMemory;
