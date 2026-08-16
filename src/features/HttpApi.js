'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

/**
 * HttpApi — bot's internal HTTP API server.
 *
 * Endpoints (all JSON):
 *   GET  /status          — bot health, rooms, counters
 *   GET  /gamedata        — all game user data
 *   POST /gamedata        — update a user's game fields (owner only)
 *   GET  /leaderboard     — top 10 by rot
 *   GET  /profile?u=      — full user profile
 *   POST /cmd             — run bot command (owner-secret auth)
 *   POST /web-action      — webtoken-gated game action from browser page
 *
 * webtoken system:
 *   - .webtoken command generates a 6-char token stored in _tokens Map (30-min TTL)
 *   - Browser page POSTs token + action to /web-action
 *   - Validated → routes to game.handleGameCommand → broadcasts to chat
 */
class HttpApi {
  /**
   * @param {number} port        — port to listen on (default 7001)
   * @param {Object} botRef      — ZomBBot instance (read-only access for stats/game)
   * @param {Object} logger      — Logger instance
   * @param {string} ownerSecret — shared secret for /cmd endpoint (from .env)
   */
  constructor(port, botRef, logger, ownerSecret) {
    this.port    = port    || 7001;
    this.bot     = botRef;
    this.log     = logger;
    this.secret  = ownerSecret || '';
    this._server = null;

    /** @type {Map<string, {nick, expiresAt}>} 6-char token → session */
    this._tokens = new Map();

    // Token persistence path — lives next to game data
    const dataDir = process.env.DATA_DIR
      || (botRef?.storage?.activeDir)
      || path.join(process.cwd(), 'ZomB_Data');
    this._tokenFile = path.join(dataDir, 'web_tokens.json');

    this._loadTokens();

    // Cleanup expired tokens every 5 min + persist after each prune
    setInterval(() => { this._pruneTokens(); this._saveTokens(); }, 5 * 60_000);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    this._server = http.createServer((req, res) => this._handle(req, res));
    this._server.listen(this.port, '0.0.0.0', () => {
      this.log?.info(`HttpApi listening on port ${this.port}`);
    });
    this._server.on('error', e => this.log?.error('HttpApi error: ' + e.message));
  }

  stop() {
    this._server?.close();
    this._server = null;
  }

  // ── Token management ──────────────────────────────────────────────────────

  issueToken(nick) {
    const token = randomBytes(3).toString('hex').toUpperCase(); // 6 chars
    // 2-hour TTL — 30 min was too short (missed after lunch, bot restart, etc.)
    this._tokens.set(token, { nick, expiresAt: Date.now() + 2 * 60 * 60_000 });
    this._saveTokens();
    return token;
  }

  _saveTokens() {
    try {
      const obj = {};
      for (const [k, v] of this._tokens) obj[k] = v;
      fs.writeFileSync(this._tokenFile, JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }

  _loadTokens() {
    try {
      if (!fs.existsSync(this._tokenFile)) return;
      const obj  = JSON.parse(fs.readFileSync(this._tokenFile, 'utf8'));
      const now  = Date.now();
      let loaded = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (v.expiresAt > now) { this._tokens.set(k, v); loaded++; }
      }
      if (loaded) this.log?.info(`HttpApi: restored ${loaded} active token(s)`);
    } catch (_) {}
  }

  _validateToken(token) {
    if (!token) return null;
    const key   = token.toUpperCase();
    const entry = this._tokens.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this._tokens.delete(key); return null; }
    return entry.nick;
  }

  _pruneTokens() {
    const now = Date.now();
    for (const [k, v] of this._tokens) {
      if (now > v.expiresAt) this._tokens.delete(k);
    }
  }

  // ── Request dispatcher ────────────────────────────────────────────────────

  _handle(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('ngrok-skip-browser-warning', 'true');

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = req.url.split('?')[0];
    const qs  = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');

    const ok  = (d, code = 200) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(d)); };
    const err = (msg, code = 500) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify({ error: msg })); };

    const readBody = () => new Promise(resolve => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end',  () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });

    // Route
    if (url === '/status' && req.method === 'GET') {
      return ok(this._buildStatus());
    }

    if (url === '/health' && req.method === 'GET') {
      const snap = this.bot.health?.snapshot?.() ?? { error: 'HealthMonitor not initialised' };
      return ok({
        ...snap,
        memory: this.bot.tieredMemory?.snapshot?.() || null,
        relationship: this.bot.relationshipState?.snapshot?.() || null,
        vector: this.bot.vectorMemory?.snapshot?.() || null,
      });
    }

    if (url === '/gamedata' && req.method === 'GET') {
      const gd = this.bot.game?.getAllUsers?.() || {};
      return ok(gd);
    }

    if (url === '/gamedata' && req.method === 'POST') {
      readBody().then(body => {
        const { username, updates } = body;
        if (!username || typeof updates !== 'object') return err('Missing username or updates', 400);
        const user = this.bot.game?.getUser?.(username.toLowerCase());
        if (!user) return err('User not found', 404);
        const PROTECTED = ['username'];
        const updated = [];
        for (const [k, v] of Object.entries(updates)) {
          if (PROTECTED.includes(k)) continue;
          if (v === null || v === undefined || v === '') continue;
          user[k] = v; updated.push(k);
        }
        // save() uses cached _saveFilePath — call with no args to auto-use it
        if (this.bot.game?.save && this.bot.game._saveFilePath) {
          this.bot.game.save(this.bot.game._saveFilePath);
        }
        return ok({ ok: true, updated });
      });
      return;
    }

    if (url === '/leaderboard' && req.method === 'GET') {
      const gd = this.bot.game?.getAllUsers?.() || {};
      const lb = Object.entries(gd)
        .map(([nick, d]) => ({
          username   : d.username || nick,
          rotPoints  : d.rotPoints || 0,
          level      : d.level || 1,
          zombieClass: d.zombieClass || 'human',
          prestige   : d.prestige || 0,
        }))
        .sort((a, b) => b.rotPoints - a.rotPoints)
        .slice(0, 10);
      return ok(lb);
    }

    if (url.startsWith('/profile') && req.method === 'GET') {
      // Accept both ?u= (legacy) and ?user= (dashboard)
      const u = qs.get('user') || qs.get('u');
      if (!u) return err('Missing ?user=', 400);
      const key      = u.toLowerCase();
      const profile  = this.bot.profiles?.get(key) || null;
      const gameData = this.bot.game?.getUser?.(key) || null;
      // Pull psych data from advanced AI subsystems
      const ctxBroker = this.bot.ctxBroker;
      const episodic  = this.bot.episodic;
      const learning  = this.bot.learning;
      const emotion   = ctxBroker?.getContext?.('zombitious', key) || ctxBroker?.getContext?.(null, key) || null;
      const memories  = episodic?.retrieveMemories?.(key, {}, 10) || [];
      const learnData = learning?.getModel?.(key) || null;
      const sampleCount = learning?.getSampleCount?.(key) || 0;
      // Recent chat messages from history (last 15)
      const histKey      = 'zombitious';
      const histMsgs     = this.bot.history?._get?.(histKey) || [];
      const recentMessages = histMsgs
        .filter(m => m.nick && m.nick.toLowerCase() === key)
        .slice(-15)
        .map(m => ({ role: 'user', content: m.content, ts: m.ts, room: histKey }));
      return ok({
        username      : u,
        profile,
        gameData,
        emotion       : emotion?.emotionalState ? { emotion: emotion.emotionalState, scores: emotion.emotionScores || {}, timestamp: emotion.lastUpdate } : null,
        emotionHistory: emotion?.emotionHistory || [],
        memories,
        learning      : { sampleCount, model: learnData },
        recentMessages,
      });
    }

    if (url === '/web-action' && req.method === 'POST') {
      readBody().then(async body => {
        const nick = this._validateToken(body.token);
        if (!nick) return err('Invalid or expired token', 401);

        const command = body.action;
        const rawArgs = body.args;
        if (!command) return err('Missing action', 400);

        // Normalise args to an array (dashboard sends arrays, some callers send strings)
        const args = Array.isArray(rawArgs) ? rawArgs
                   : (rawArgs ? String(rawArgs).split(' ').filter(Boolean) : []);

        const roomName = body.room || [...(this.bot.rooms?.keys() || [])][0] || 'zombitious';

        try {
          // Correct signature: handleGameCommand(roomName, username, command, args)
          const result = await this.bot.game?.handleGameCommand?.(roomName, nick, command, args);
          // Only broadcast duels and fusions to room chat
          const BROADCAST = ['duel', 'accept', 'petfuse'];
          if (BROADCAST.includes(command) && result) {
            const msg = typeof result === 'string' ? result : (Array.isArray(result) ? result[0] : '');
            if (msg) await this.bot.send(roomName, `🌐 ${nick}: ${msg}`, { force: true });
          }
          // Push toast to the player's game page via SSE
          const resultStr = typeof result === 'string' ? result : (Array.isArray(result) ? result.join(' | ') : '');
          if (resultStr) this.bot.pushDashboardEvent({ type: 'toast', data: { username: nick, action: command, result: resultStr } });
          return ok({ success: true, result, username: nick });
        } catch (e) {
          return err(e.message);
        }
      });
      return; // async
    }

    if (url.startsWith('/story-status') && req.method === 'GET') {
      const u = qs.get('u');
      if (!u) return ok({ error: 'missing u param' });
      const status = this.bot.game?.getStoryStatus?.(u) || { error: 'not found' };
      return ok(status);
    }

    if (url === '/shop-items' && req.method === 'GET') {
      const catalogue = this.bot.game?.getShopCatalogue?.() || [];
      return ok(catalogue);
    }

    if (url === '/self-eval' && req.method === 'GET') {
      const snap = this.bot.selfEval?.snapshot?.() ?? { error: 'SelfEval not initialised' };
      return ok(snap);
    }

    if (url === '/self-eval' && req.method === 'POST') {
      readBody().then(body => {
        if (!this.secret || body.secret !== this.secret) return err('Unauthorized', 401);
        const result = this.bot.selfEval?.run?.(false) ?? { error: 'SelfEval not initialised' };
        return ok(result);
      });
      return;
    }

    if (url.startsWith('/profile') && req.method === 'POST') {
      readBody().then(body => {
        const { username, updates } = body;
        if (!username || typeof updates !== 'object') return err('Missing username or updates', 400);
        const PROTECTED = ['username', 'firstSeen', 'psychProfile'];
        const cleaned = {};
        for (const [k, v] of Object.entries(updates)) {
          if (PROTECTED.includes(k)) continue;
          cleaned[k] = v;
        }
        this.bot.profiles?.update?.(username.toLowerCase(), cleaned);
        this.bot.profiles?.save?.();
        return ok({ ok: true, updated: Object.keys(cleaned) });
      });
      return;
    }

    if (url === '/live-users' && req.method === 'GET') {
      const rooms = {};
      const botNick = (this.bot._AI_CONFIG?.botNick || '').toLowerCase();
      for (const [roomName, room] of (this.bot.rooms || new Map())) {
        const list = [];
        // Use per-room activeUsers if available, fall back to wsListener._nickMap
        const roomMap = room.activeUsers instanceof Map
          ? room.activeUsers
          : (room.wsListener?._nickMap || new Map());
        for (const [handle, entry] of roomMap) {
          const nick = typeof entry === 'string' ? entry : entry?.nick;
          if (!nick || nick.toLowerCase() === botNick) continue;
          const { role } = this.bot.identity?.identify?.(nick, handle) || { role: 'user' };
          const onCam = room.camUsers?.has(handle) || (typeof entry === 'object' && entry?.onCam) || false;
          list.push({ handle, nick, role, onCam });
        }
        rooms[roomName] = list;
      }
      return ok({ rooms });
    }

    if (url.startsWith('/conversation') && req.method === 'GET') {
      const user = (qs.get('user') || '').toLowerCase();
      const room = qs.get('room') || 'zombitious';
      if (!user) return err('Missing ?user=', 400);
      const msgs = this.bot.history?._get?.(room) || [];
      const conversation = msgs
        .filter(m => m.nick?.toLowerCase() === user || m.role === 'assistant')
        .slice(-40)
        .map(m => ({ role: m.role === 'assistant' ? 'bot' : 'user', content: m.content, ts: m.ts }));
      return ok(conversation);
    }

    if (url.startsWith('/emotion_timeline') && req.method === 'GET') {
      const room = qs.get('room') || 'zombitious';
      const snapshots = this.bot.ctxBroker?.getEmotionTimeline?.(room) || [];
      return ok(snapshots);
    }

    if (url.startsWith('/wordcloud') && req.method === 'GET') {
      const room = qs.get('room') || 'zombitious';
      const words = this.bot.ctxBroker?.getWordCloud?.(room) || [];
      return ok(words);
    }

    if (url === '/psych-intel' && req.method === 'GET') {
      const pa = this.bot.psychAnalyzer;
      if (!pa || !this.bot.memoryFeatures?.psychAnalyzerEnabled) {
        return ok({ enabled: false, users: [], rooms: {} });
      }
      const room = qs.get('room') || 'zombitious';
      const users = pa.getAllAnalyses(room);
      const roomNames = [...(this.bot.rooms?.keys() || [room])];
      const rooms = {};
      for (const rn of roomNames) {
        const snap = pa.getRoomSnapshot(rn);
        if (snap) rooms[rn] = snap;
      }
      return ok({ enabled: true, users, rooms, ts: Date.now() });
    }

    if (url === '/cmd' && req.method === 'POST') {
      readBody().then(async body => {
        if (!this.secret || body.secret !== this.secret) return err('Unauthorized', 401);
        const { command, room } = body;
        const text = body.text || body.message;
        if (text) {
          const r = room || [...(this.bot.rooms?.keys() || [])][0];
          await this.bot.send(r, text, { force: true });
          return ok({ sent: text });
        }
        if (command) {
          const r = room || [...(this.bot.rooms?.keys() || [])][0];
          const result = await this.bot.queue?.route?.(r, 'Death', '.' + command, this.bot) || null;
          if (result) await this.bot.send(r, result, { force: true });
          return ok({ ran: command, result });
        }
        return err('Provide text or command', 400);
      });
      return; // async
    }

    // Slideshow media files — served from CAMERA_SLIDESHOW_DIR
    if (url.startsWith('/media/') && req.method === 'GET') {
      const filename = decodeURIComponent(url.slice(7));
      const slideshowDir = process.env.CAMERA_SLIDESHOW_DIR
        || this.bot._AI_CONFIG?.slideshowDir
        || this.bot.rooms?.constructor?.CONFIG?.CAMERA_SLIDESHOW_DIR;
      if (!slideshowDir) return err('Slideshow dir not configured', 503);
      const filepath = path.join(slideshowDir, path.basename(filename));
      if (!fs.existsSync(filepath)) { return err('Not found', 404); }
      const ext  = path.extname(filename).toLowerCase();
      const mime = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
      const stat = fs.statSync(filepath);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(filepath).pipe(res);
    }

    err('Not found', 404);
  }

  // ── Status payload ────────────────────────────────────────────────────────

  _buildStatus() {
    const bot = this.bot;
    // Collect active users from handle map (users seen in rooms)
    const handleMap  = bot._handleMap || new Map();
    const activeUsers = [...new Set([...handleMap.values()])]
      .filter(n => n && n !== bot._AI_CONFIG?.botNick && !/^[0-9a-f]{20,}$/i.test(n))
      .slice(0, 50);
    return {
      name           : 'ZomB v3.0',
      uptime         : bot.uptime || Date.now(),          // timestamp — dashboard subtracts from Date.now()
      rooms          : [...(bot.rooms?.keys() || [])],
      messageCounter : bot.queue?.messageCounter || 0,
      aiAvailable    : bot.aiAvailable || false,
      aiModelWarm    : bot.aiModelWarm || false,
      globalMute     : bot.queue?.globalMute || false,
      currentMood    : bot.currentMood || 'neutral',
      currentMoodHint: bot.mood?.zombHint || '',
      activeUsers,
      version        : '3.0',
    };
  }
}

module.exports = HttpApi;
