'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * SelfEval — daily automated self-assessment checklist for ZomBBot.
 *
 * Fires at midnight each night, scores 8 performance dimensions,
 * saves a 30-day history, and optionally announces results in chat.
 *
 * Hooks to call from ZomBBot / MessageQueue / OllamaClient:
 *   selfEval.onMsg()          — each incoming chat message
 *   selfEval.onResponded()    — each AI response sent
 *   selfEval.onAiError()      — each Ollama error
 *   selfEval.onAiRetry()      — each Ollama retry
 *   selfEval.onCmd(ok)        — each command resolved
 *   selfEval.onDraft()        — each AI draft generated
 *   selfEval.onReject()       — each draft rejected (also counts as a draft)
 *   selfEval.onQueuePeak(n)   — periodically report message queue depth
 *   selfEval.onMoodChange()   — each mood state transition
 *   selfEval.onReconnect()    — each WS reconnect
 */
class SelfEval {
  constructor(botRef, logger) {
    this.bot  = botRef;
    this.log  = logger;

    this._file     = null;
    this._counters = this._blank();
    this._lastEval = null;
    this._history  = [];

    this._scheduleDaily();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  setDataFile(filePath) {
    this._file = filePath;
    this._load();
  }

  _blank() {
    return {
      startMs    : Date.now(),
      msgs       : 0,
      responded  : 0,
      aiErrors   : 0,
      aiRetries  : 0,
      cmdTotal   : 0,
      cmdOk      : 0,
      draftsGen  : 0,
      draftsRej  : 0,
      queuePeaks : [],
      moodChanges: 0,
      reconnects : 0,
    };
  }

  // ── Increment hooks ───────────────────────────────────────────────────────

  onMsg()           { this._counters.msgs++; }
  onResponded()     { this._counters.responded++; }
  onAiError()       { this._counters.aiErrors++; }
  onAiRetry()       { this._counters.aiRetries++; }
  onCmd(ok = true)  { this._counters.cmdTotal++; if (ok) this._counters.cmdOk++; }
  onDraft()         { this._counters.draftsGen++; }
  onReject()        { this._counters.draftsRej++; this._counters.draftsGen++; }
  onQueuePeak(n)    { this._counters.queuePeaks.push(n); if (this._counters.queuePeaks.length > 500) this._counters.queuePeaks.shift(); }
  onMoodChange()    { this._counters.moodChanges++; }
  onReconnect()     { this._counters.reconnects++; }

  // ── Daily schedule ────────────────────────────────────────────────────────

  _scheduleDaily() {
    const now  = new Date();
    const tmrw = new Date(now);
    tmrw.setHours(24, 0, 5, 0);
    const ms = tmrw - now;
    this._dailyTimeout = setTimeout(() => {
      this.run(false);
      this._dailyInterval = setInterval(() => this.run(false), 86400000);
    }, ms);
    if (this._dailyTimeout?.unref) this._dailyTimeout.unref();
  }

  // ── Core eval ─────────────────────────────────────────────────────────────

  run(announce = false) {
    const result = this._score();
    this._lastEval = result;
    this._history.unshift(result);
    if (this._history.length > 30) this._history.pop();
    this._counters = this._blank();
    this._save();
    this.log?.info(`[SelfEval] ${result.date}: ${result.overall}/100 (${result.grade}) — ${result.items.filter(i => i.pass).length}/${result.items.length} checks passed`);
    if (announce) this._announce(result);
    return result;
  }

  _score(c = this._counters) {
    const ms        = Date.now() - c.startMs;
    const h         = ms / 3600000;

    const uptime    = Math.max(0, 100 - c.reconnects * 5);
    const respRate  = c.msgs > 0 ? Math.min(100, (c.responded / c.msgs) * 100) : 100;
    const errScore  = c.msgs > 0 ? Math.max(0, 100 - (c.aiErrors  / c.msgs) * 1000) : 100;
    const cmdScore  = c.cmdTotal  > 0 ? (c.cmdOk   / c.cmdTotal)   * 100 : 100;
    const qualScore = c.draftsGen > 0 ? Math.max(0, 100 - (c.draftsRej / c.draftsGen) * 100) : 100;
    const avgPeak   = c.queuePeaks.length ? c.queuePeaks.reduce((a, b) => a + b, 0) / c.queuePeaks.length : 0;
    const qScore    = Math.max(0, 100 - avgPeak * 5);
    const moodRate  = h > 0 ? c.moodChanges / h : 0;
    const moodScore = Math.max(0, 100 - Math.max(0, moodRate - 3) * 8);
    const retScore  = c.msgs > 0 ? Math.max(0, 100 - (c.aiRetries / c.msgs) * 500) : 100;

    const items = [
      { id: 'uptime',      label: 'Uptime',          score: Math.round(uptime),    target: 99,  pass: uptime    >= 95 },
      { id: 'resp_rate',   label: 'Response Rate',   score: Math.round(respRate),  target: 80,  pass: respRate  >= 80 },
      { id: 'ai_errors',   label: 'AI Error Rate',   score: Math.round(errScore),  target: 90,  pass: errScore  >= 90 },
      { id: 'cmd_success', label: 'Commands',        score: Math.round(cmdScore),  target: 95,  pass: cmdScore  >= 95 },
      { id: 'draft_qual',  label: 'Draft Quality',   score: Math.round(qualScore), target: 70,  pass: qualScore >= 70 },
      { id: 'queue',       label: 'Queue Health',    score: Math.round(qScore),    target: 80,  pass: qScore    >= 80 },
      { id: 'mood',        label: 'Mood Stability',  score: Math.round(moodScore), target: 75,  pass: moodScore >= 75 },
      { id: 'ai_retries',  label: 'AI Retries',      score: Math.round(retScore),  target: 85,  pass: retScore  >= 85 },
    ];

    const W = { uptime: 2, resp_rate: 2, ai_errors: 2, cmd_success: 1.5, draft_qual: 1, queue: 1, mood: 1, ai_retries: 1 };
    let ws = 0, wt = 0;
    for (const it of items) { const w = W[it.id] || 1; ws += it.score * w; wt += w; }
    const overall = Math.round(ws / wt);
    const grade   = overall >= 95 ? 'S' : overall >= 85 ? 'A' : overall >= 75 ? 'B' : overall >= 60 ? 'C' : overall >= 40 ? 'D' : 'F';

    return {
      ts       : Date.now(),
      date     : new Date().toISOString().split('T')[0],
      periodMs : ms,
      overall,
      grade,
      items,
      raw: {
        msgs: c.msgs, responded: c.responded,
        aiErrors: c.aiErrors, aiRetries: c.aiRetries,
        cmdTotal: c.cmdTotal, cmdOk: c.cmdOk,
        draftsGen: c.draftsGen, draftsRej: c.draftsRej,
        moodChanges: c.moodChanges, reconnects: c.reconnects,
      },
    };
  }

  _announce(r) {
    try {
      const pass  = r.items.filter(i => i.pass).length;
      const total = r.items.length;
      const msg   = `📊 [Daily Self-Eval] Score: ${r.overall}/100 (Grade: ${r.grade}) | ${pass}/${total} checks passed | Top issues: ${r.items.filter(i => !i.pass).map(i => i.label).join(', ') || 'none 🎉'}`;
      const rooms = [...(this.bot?.rooms?.keys() || [])];
      if (rooms[0]) this.bot?.send?.(rooms[0], msg, { force: true }).catch(() => {});
    } catch (_) {}
  }

  // ── Dashboard snapshot (live scores, no reset) ────────────────────────────

  snapshot() {
    const live = this._score();
    return {
      live,
      lastEval : this._lastEval,
      history  : this._history.slice(0, 7),
    };
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _load() {
    try {
      if (!this._file || !fs.existsSync(this._file)) return;
      const d = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      if (Array.isArray(d.history))  this._history  = d.history;
      if (d.lastEval)                this._lastEval = d.lastEval;
      if (d.counters) {
        this._counters = { ...this._blank(), ...d.counters, startMs: Date.now() };
      }
      this.log?.info(`[SelfEval] Loaded history (${this._history.length} entries)`);
    } catch (_) {}
  }

  _save() {
    if (!this._file) return;
    try {
      fs.writeFileSync(this._file, JSON.stringify({
        lastEval : this._lastEval,
        history  : this._history,
        counters : this._counters,
      }, null, 2), 'utf8');
    } catch (_) {}
  }

  destroy() {
    clearTimeout(this._dailyTimeout);
    clearInterval(this._dailyInterval);
    this._save();
  }
}

module.exports = SelfEval;
