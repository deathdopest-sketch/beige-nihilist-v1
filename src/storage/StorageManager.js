'use strict';

const fs   = require('fs');
const path = require('path');

// Keys that get synced to Postgres — everything else stays file-only
const PG_SYNC_KEYS = new Set([
  'interactions',   // user profiles — most valuable
  'gameData',       // rot, levels, items, pvp stats
  'tieredMemory',   // conversation history
  'state',          // bot state
  'handles',        // handle→nick cache
  'gamblingPrefs',  // gambling settings
  'relationshipState',
]);

/**
 * Handles all persistence for ZomB — JSON state files, backups, auto-save.
 * Optional Postgres sync layer (Neon): set ZOMB_PG_URL in .env to enable.
 * On write: syncs critical keys to Postgres async (non-blocking, fails silent).
 * On read: loads from Postgres first if available, falls back to local JSON.
 */
class StorageManager {
  constructor(storageDir, logger) {
    this.storageDir = storageDir;
    this.log = logger;

    this.backupDir     = path.join(storageDir, 'Backups');
    this.activeDir     = path.join(storageDir, 'Active_Memory');
    this.advancedDir   = path.join(storageDir, 'AdvancedMemory');
    this.maxBackups    = 48;

    this.paths = {
      users:          path.join(this.activeDir, 'zomb_users.json'),
      interactions:   path.join(this.activeDir, 'zomb_interactions.json'),
      state:          path.join(this.activeDir, 'zomb_state.json'),
      commandLog:     path.join(this.activeDir, 'zomb_command_log.json'),
      ownerHandles:   path.join(this.activeDir, 'zomb_owner_handles.json'),
      behaviorRecord: path.join(this.activeDir, 'zomb_behavior_record.json'),
      aiState:        path.join(this.activeDir, 'zomb_ai_state.json'),
      handles:        path.join(this.activeDir, 'zomb_handles.json'),
      trainingData:   path.join(this.activeDir, 'zomb_training_data.jsonl'),
      gameData:       path.join(this.activeDir, 'zomb_game.json'),
      gamblingPrefs:  path.join(this.activeDir, 'zomb_gambling_prefs.json'),
      tieredMemory:   path.join(this.activeDir, 'zomb_tiered_memory.json'),
      vectorMemory:   path.join(this.activeDir, 'zomb_vector_memory.json'),
      relationshipState: path.join(this.activeDir, 'zomb_relationship_state.json'),
      wsLog:          path.join(storageDir,     'zomb_ws.log'),
      botLog:         path.join(storageDir,     'zomb_boot.log'),
      activityLog:    path.join(storageDir,     'zomb_activity.log'),
    };

    // Reverse map: filePath → key name (for sync layer)
    this._pathToKey = Object.fromEntries(
      Object.entries(this.paths).map(([k, v]) => [v, k])
    );

    this._autoSaveTimer = null;
    this._backupTimer   = null;
    this._pgPool        = null;
    this._pgReady       = false;
    this._pgConnecting  = false;
  }

  // ── Directory init ───────────────────────────────────────────────────────────

  init() {
    const dirs = [
      this.storageDir,
      this.backupDir,
      this.activeDir,
      this.advancedDir,
      path.join(this.advancedDir, 'Backups'),
    ];
    for (const d of dirs) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
    this.log?.info('Storage directories initialised');
    // Fire-and-forget Postgres init — doesn't block startup
    this._initPg().catch(() => {});
  }

  // ── Postgres sync layer ──────────────────────────────────────────────────────

  async _initPg() {
    const connStr = process.env.ZOMB_PG_URL;
    if (!connStr || this._pgConnecting) return;
    this._pgConnecting = true;
    try {
      const { Pool } = require('pg');
      // idleTimeoutMillis=3s: destroy idle connections BEFORE Neon's serverless proxy
      // kills them (~5s idle), so the pool never hands out a dead socket.
      // connectionTimeoutMillis=15s: Neon cold-start can take up to ~10s.
      this._pgPool = new Pool({
        connectionString: connStr,
        ssl: { rejectUnauthorized: false },
        max: 2,
        idleTimeoutMillis: 3_000,
        connectionTimeoutMillis: 15_000,
        allowExitOnIdle: false,
      });
      // Create table if it doesn't exist
      await this._pgPool.query(`
        CREATE TABLE IF NOT EXISTS zomb_kv (
          key        TEXT PRIMARY KEY,
          data       JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      this._pgReady = true;
      this.log?.info('[Storage] Neon Postgres connected ✅');

      // Heartbeat every 20s — keeps Neon compute awake (auto-suspends after 5min idle)
      if (this._pgHeartbeat) clearInterval(this._pgHeartbeat);
      this._pgHeartbeat = setInterval(async () => {
        if (!this._pgPool || !this._pgReady) return;
        try {
          await this._pgPool.query('SELECT 1');
        } catch (_) {
          // Connection dropped — trigger reconnect
          this._pgReady = false;
          this._pgConnecting = false;
          this._initPg().catch(() => {});
        }
      }, 20_000);
      if (this._pgHeartbeat.unref) this._pgHeartbeat.unref();
    } catch (e) {
      this._pgReady = false;
      this.log?.warn(`[Storage] Neon Postgres unavailable — file-only mode: ${e.message}`);
    } finally {
      this._pgConnecting = false;
    }
  }

  _keyForPath(filePath) {
    return this._pathToKey[filePath] || null;
  }

  // Non-blocking fire-and-forget sync to Postgres
  _pgSyncAsync(key, data) {
    if (!this._pgReady || !this._pgPool) return;
    this._pgPool.query(
      `INSERT INTO zomb_kv (key, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [key, JSON.stringify(data)]
    ).catch(e => {
      this.log?.warn(`[Storage] Postgres sync failed for "${key}": ${e.message}`);
      // Connection-level errors: tear down pool and reconnect
      const isConnErr = e.message.includes('terminated') || e.message.includes('timeout') || e.message.includes('ECONNRESET');
      if (isConnErr && this._pgReady) {
        this._pgReady = false;
        this._pgConnecting = false;
        setTimeout(() => this._initPg().catch(() => {}), 5_000);
      }
    });
  }

  async _pgRead(key) {
    if (!this._pgReady || !this._pgPool) return null;
    try {
      const res = await this._pgPool.query('SELECT data FROM zomb_kv WHERE key = $1', [key]);
      return res.rows[0]?.data ?? null;
    } catch (e) {
      this.log?.warn(`[Storage] Postgres read failed for "${key}": ${e.message}`);
      return null;
    }
  }

  // Wait up to maxMs for Postgres to connect (resolves early if ready)
  waitPgReady(maxMs = 6000) {
    if (this._pgReady) return Promise.resolve();
    return new Promise(resolve => {
      const start = Date.now();
      const poll = setInterval(() => {
        if (this._pgReady || Date.now() - start >= maxMs) {
          clearInterval(poll);
          resolve();
        }
      }, 200);
    });
  }

  // Pull all synced keys from Postgres and write to local files
  // Called once at startup before _loadMemory() so local files are up to date
  async restoreFromPg() {
    if (!this._pgReady || !this._pgPool) return;
    try {
      const res = await this._pgPool.query(
        `SELECT key, data FROM zomb_kv WHERE key = ANY($1)`,
        [Array.from(PG_SYNC_KEYS)]
      );
      if (!res.rows.length) return;
      for (const { key, data } of res.rows) {
        const filePath = this.paths[key];
        if (!filePath || !filePath.endsWith('.json')) continue;
        try {
          const tmp = filePath + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
          fs.renameSync(tmp, filePath);
        } catch (_) {}
      }
      this.log?.info(`[Storage] Restored ${res.rows.length} key(s) from Neon Postgres`);
    } catch (e) {
      this.log?.warn(`[Storage] restoreFromPg failed: ${e.message}`);
    }
  }

  // ── Safe JSON I/O ────────────────────────────────────────────────────────────

  read(filePath, fallback = {}) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      this.log?.warn(`StorageManager.read failed for ${filePath}: ${e.message}`);
      return fallback;
    }
  }

  /**
   * Async read — tries Postgres first for synced keys, falls back to local file.
   * Use this in module load() methods for Postgres-backed data.
   */
  async readAsync(filePath, fallback = {}) {
    const key = this._keyForPath(filePath);
    if (key && PG_SYNC_KEYS.has(key)) {
      const pgData = await this._pgRead(key);
      if (pgData !== null) {
        this.log?.info(`[Storage] Loaded "${key}" from Neon Postgres`);
        // Also write back to local file so offline mode stays in sync
        this.write(filePath, pgData);
        return pgData;
      }
    }
    return this.read(filePath, fallback);
  }

  write(filePath, data) {
    try {
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, filePath);

      // Async sync to Postgres for critical keys
      const key = this._keyForPath(filePath);
      if (key && PG_SYNC_KEYS.has(key)) {
        this._pgSyncAsync(key, data);
      }

      return true;
    } catch (e) {
      this.log?.error(`StorageManager.write failed for ${filePath}: ${e.message}`);
      return false;
    }
  }

  appendJsonl(filePath, record) {
    try {
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
    } catch (e) {
      this.log?.warn(`StorageManager.appendJsonl failed: ${e.message}`);
    }
  }

  // ── Auto-save ────────────────────────────────────────────────────────────────

  startAutoSave(saveCallback, intervalMs = 60_000) {
    if (this._autoSaveTimer) clearInterval(this._autoSaveTimer);
    this._autoSaveTimer = setInterval(() => {
      try { saveCallback(); } catch (e) { this.log?.error('Auto-save error: ' + e.message); }
    }, intervalMs);
    this.log?.info(`Auto-save started (every ${intervalMs / 1000}s)`);
  }

  // ── Backup system ────────────────────────────────────────────────────────────

  startBackupSystem(saveCallback, intervalMs = 30 * 60_000) {
    if (this._backupTimer) clearInterval(this._backupTimer);
    this._backupTimer = setInterval(async () => {
      try {
        saveCallback();
        await this.createBackup();
      } catch (e) {
        this.log?.error('Backup error: ' + e.message);
      }
    }, intervalMs);
    this.log?.info(`Backup system started (every ${intervalMs / 60000}m)`);
  }

  async createBackup() {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.backupDir, `backup_${ts}`);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    for (const [key, src] of Object.entries(this.paths)) {
      if (!src.endsWith('.json') && !src.endsWith('.jsonl')) continue;
      if (!fs.existsSync(src)) continue;
      try {
        fs.copyFileSync(src, path.join(dest, path.basename(src)));
      } catch (_) {}
    }

    await this.cleanupOldBackups();
    this.log?.info(`Backup created: ${dest}`);
    return dest;
  }

  async cleanupOldBackups() {
    try {
      const entries = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('backup_'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(this.backupDir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);

      const toDelete = entries.slice(this.maxBackups);
      for (const { name } of toDelete) {
        const p = path.join(this.backupDir, name);
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch (e) {
      this.log?.warn('cleanupOldBackups error: ' + e.message);
    }
  }

  async createNamedCheckpoint(label = 'manual') {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
    const dest = path.join(this.backupDir, `checkpoint_${safe}_${ts}`);
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    for (const src of Object.values(this.paths)) {
      if (!src.endsWith('.json') && !src.endsWith('.jsonl')) continue;
      if (!fs.existsSync(src)) continue;
      try {
        fs.copyFileSync(src, path.join(dest, path.basename(src)));
      } catch (_) {}
    }

    this.log?.info(`Named checkpoint saved: ${dest}`);
    return dest;
  }

  listNamedCheckpoints() {
    try {
      return fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('checkpoint_'))
        .sort()
        .reverse();
    } catch (_) {
      return [];
    }
  }

  stop() {
    if (this._autoSaveTimer) { clearInterval(this._autoSaveTimer); this._autoSaveTimer = null; }
    if (this._backupTimer)   { clearInterval(this._backupTimer);   this._backupTimer   = null; }
    if (this._pgPool)        { this._pgPool.end().catch(() => {}); this._pgPool = null; }
  }
}

module.exports = StorageManager;
