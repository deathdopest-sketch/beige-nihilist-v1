'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Lightweight structured logger for ZomB.
 * Writes to console + optional log file. WS traffic gets its own rotating file.
 */
class Logger {
  constructor(storageDir, bootLogPath) {
    this.storageDir = storageDir;
    this.wsLogFile    = null;
    this.wsLogEnabled = true;
    this._maxWsLogBytes = 50 * 1024 * 1024; // 50 MB
    this._bootLogFile = bootLogPath || null;
  }

  setBootLogPath(p)     { this._bootLogFile     = p; }
  setWsLogPath(p)       { this.wsLogFile         = p; }
  setActivityLogPath(p) { this._activityLogFile  = p; }

  // ── General logging ─────────────────────────────────────────────────────────

  info(message, meta = {})  { this._write('INFO',  message, meta); }
  warn(message, meta = {})  { this._write('WARN',  message, meta); }
  error(message, meta = {}) { this._write('ERROR', message, meta); }
  debug(message, meta = {}) { this._write('DEBUG', message, meta); }

  _write(level, message, meta) {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level}]`;
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    const line = `${prefix} ${message}${metaStr}`;
    console.log(line);
    if (this._bootLogFile) {
      try { fs.appendFileSync(this._bootLogFile, line + '\n'); } catch (_) {}
    }
  }

  // ── Activity log — what ZomB is actually doing ──────────────────────────────

  activity(type, data = {}) {
    if (!this._activityLogFile) return;
    try {
      const entry = JSON.stringify({ ts: Date.now(), type, ...data }) + '\n';
      try {
        const stat = fs.statSync(this._activityLogFile);
        if (stat.size > 10 * 1024 * 1024) {
          fs.renameSync(this._activityLogFile, this._activityLogFile + '.old');
        }
      } catch (_) {}
      fs.appendFileSync(this._activityLogFile, entry);
    } catch (_) {}
  }

  // ── WebSocket traffic log ────────────────────────────────────────────────────

  logWs(roomName, direction, type, data) {
    if (!this.wsLogEnabled || !this.wsLogFile) return;
    try {
      const entry = JSON.stringify({
        ts: Date.now(),
        room: roomName,
        dir: direction,
        type,
        data: typeof data === 'string' ? data.substring(0, 500) : data,
      }) + '\n';

      // Rotate if over size limit
      try {
        const stat = fs.statSync(this.wsLogFile);
        if (stat.size > this._maxWsLogBytes) {
          fs.renameSync(this.wsLogFile, this.wsLogFile + '.old');
        }
      } catch (_) {}

      fs.appendFileSync(this.wsLogFile, entry);
    } catch (_) {}
  }
}

module.exports = Logger;
