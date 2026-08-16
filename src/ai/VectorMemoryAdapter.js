'use strict';

class VectorMemoryError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'VectorMemoryError';
    this.code = code;
    this.cause = cause || undefined;
  }
}

class VectorMemoryAdapter {
  constructor(config = {}) {
    this.config = {
      backend          : config.backend || 'memory',
      maxQueryResults  : Number.isFinite(config.maxQueryResults) ? Math.max(1, Math.min(100, config.maxQueryResults)) : 12,
      maxRecords       : Number.isFinite(config.maxRecords) ? Math.max(100, Math.min(200000, config.maxRecords)) : 12000,
      defaultTtlMs     : Number.isFinite(config.defaultTtlMs) ? Math.max(60_000, config.defaultTtlMs) : null,
      cleanupBatchSize : Number.isFinite(config.cleanupBatchSize) ? Math.max(50, Math.min(5000, config.cleanupBatchSize)) : 500,
      backendTimeoutMs : Number.isFinite(config.backendTimeoutMs) ? Math.max(500, Math.min(60_000, config.backendTimeoutMs)) : 7000,
      sqlitePath       : config.sqlitePath || null,
      tableName        : config.tableName || 'zomb_vector_memory',
      pg: {
        connectionString: config.pg?.connectionString || process.env.ZOMB_VECTOR_PG_URL || null,
        ssl             : config.pg?.ssl ?? false,
      },
      chromadb: {
        apiKey    : config.chromadb?.apiKey     || process.env.ZOMB_CHROMA_API_KEY || null,
        tenant    : config.chromadb?.tenant     || process.env.ZOMB_CHROMA_TENANT  || null,
        database  : config.chromadb?.database   || process.env.ZOMB_CHROMA_DATABASE|| 'Death1',
        collection: config.chromadb?.collection || process.env.ZOMB_CHROMA_COLLECTION || 'zomb_memory',
        path      : config.chromadb?.path       || 'https://api.trychroma.com:8000',
      },
      ...config,
    };

    this.embeddingProvider = config.embeddingProvider || null;
    this._memory = [];
    this._sqlite = null;
    this._pgPool = null;
    this._chromaClient = null;
    this._chromaCollection = null;
    this._ready = false;

    this.metrics = {
      inserted: 0,
      queried: 0,
      deletedExpired: 0,
      embeddingErrors: 0,
      backendErrors: 0,
      backendTimeouts: 0,
      fallbackEmbeddings: 0,
      initErrors: 0,
      lastCleanupTs: 0,
      lastErrorCode: null,
    };
  }

  async init() {
    if (this._ready) return true;
    try {
      if (this.config.backend === 'memory') {
        this._ready = true;
        return true;
      }
      if (this.config.backend === 'sqlite') {
        await this._initSqlite();
        this._ready = true;
        return true;
      }
      if (this.config.backend === 'pgvector' || this.config.backend === 'postgres') {
        await this._initPostgres();
        this._ready = true;
        return true;
      }
      if (this.config.backend === 'chromadb') {
        const cfg = this.config.chromadb;
        if (!cfg.apiKey || !cfg.tenant) {
          // No cloud credentials configured — degrade silently to in-memory
          this.config.backend = 'memory';
          this._ready = true;
          return true;
        }
        try {
          await this._initChroma();
        } catch (e) {
          if (e.code === 'chroma_dependency_missing' || e.code === 'chroma_key_missing' || e.code === 'chroma_tenant_missing') {
            this.config.backend = 'memory';
            this._ready = true;
            return true;
          }
          throw e;
        }
        this._ready = true;
        return true;
      }
      throw new VectorMemoryError('unsupported_backend', `Unsupported vector backend: ${this.config.backend}`);
    } catch (e) {
      this.metrics.initErrors++;
      this.metrics.lastErrorCode = e.code || 'init_failed';
      throw this._wrapErr('init_failed', 'Vector backend initialization failed', e);
    }
  }

  async close() {
    if (this._sqlite) {
      await new Promise(resolve => this._sqlite.close(() => resolve()));
      this._sqlite = null;
    }
    if (this._pgPool) {
      await this._pgPool.end().catch(() => {});
      this._pgPool = null;
    }
    this._chromaClient = null;
    this._chromaCollection = null;
    this._ready = false;
  }

  async add({ id, text, metadata = {}, ttlMs = null }) {
    this._validateRecordInput(id, text, metadata);
    await this.init();

    const expiresAt = Number.isFinite(ttlMs)
      ? Date.now() + Math.max(1_000, ttlMs)
      : (Number.isFinite(this.config.defaultTtlMs) ? Date.now() + this.config.defaultTtlMs : null);

    let embedding = null;
    try {
      embedding = await this._embed(text);
    } catch (e) {
      this.metrics.embeddingErrors++;
      this.metrics.lastErrorCode = e.code || 'embedding_failed';
      embedding = null;
    }

    try {
      if (this.config.backend === 'memory') {
        this._memory.push({ id, text, embedding, metadata, ts: Date.now(), expiresAt });
        this._boundMemoryRecords();
      } else if (this.config.backend === 'sqlite') {
        await this._withTimeout(this._sqliteInsert({ id, text, embedding, metadata, expiresAt }), 'sqlite_timeout');
      } else if (this.config.backend === 'chromadb') {
        await this._withTimeout(this._chromaInsert({ id, text, embedding, metadata, expiresAt }), 'chroma_timeout');
      } else {
        await this._withTimeout(this._pgInsert({ id, text, embedding, metadata, expiresAt }), 'pg_timeout');
      }
      this.metrics.inserted++;
      return true;
    } catch (e) {
      this.metrics.backendErrors++;
      this.metrics.lastErrorCode = e.code || 'insert_failed';
      throw this._wrapErr('insert_failed', 'Vector record insert failed', e);
    }
  }

  async query({ text, metadata = null, limit = null }) {
    const safeLimit = Math.max(1, Math.min(this.config.maxQueryResults, Number.isFinite(limit) ? limit : this.config.maxQueryResults));
    const q = typeof text === 'string' ? text.trim() : '';
    if (!q) return [];
    await this.init();

    this.metrics.queried++;
    await this.cleanupExpired().catch(() => {});

    let qEmbedding = null;
    try {
      qEmbedding = await this._embed(q);
    } catch (_) {
      this.metrics.embeddingErrors++;
      qEmbedding = null;
    }

    try {
      let rows = [];
      if (this.config.backend === 'memory') {
        rows = this._memoryRows(metadata);
      } else if (this.config.backend === 'sqlite') {
        rows = await this._withTimeout(this._sqliteRows(metadata, safeLimit * 8), 'sqlite_timeout');
      } else if (this.config.backend === 'chromadb') {
        // ChromaDB does its own similarity ranking — return directly
        return await this._withTimeout(this._chromaQuery({ text, embedding: qEmbedding, metadata, limit: safeLimit }), 'chroma_timeout');
      } else {
        rows = await this._withTimeout(this._pgRows(metadata, safeLimit * 8), 'pg_timeout');
      }

      const scored = rows.map(r => ({
        id      : r.id,
        text    : r.text,
        metadata: r.metadata || {},
        ts      : r.ts || Date.now(),
        score   : this._score(q, qEmbedding, r),
      }));

      return scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts)).slice(0, safeLimit);
    } catch (e) {
      this.metrics.backendErrors++;
      this.metrics.lastErrorCode = e.code || 'query_failed';
      throw this._wrapErr('query_failed', 'Vector query failed', e);
    }
  }

  async cleanupExpired() {
    await this.init();
    const now = Date.now();
    this.metrics.lastCleanupTs = now;
    try {
      let removed = 0;
      if (this.config.backend === 'memory') {
        const before = this._memory.length;
        this._memory = this._memory.filter(r => !(r.expiresAt && r.expiresAt <= now));
        removed = before - this._memory.length;
      } else if (this.config.backend === 'sqlite') {
        removed = await this._withTimeout(this._sqliteDeleteExpired(now), 'sqlite_timeout');
      } else if (this.config.backend === 'chromadb') {
        removed = await this._withTimeout(this._chromaDeleteExpired(now), 'chroma_timeout');
      } else {
        removed = await this._withTimeout(this._pgDeleteExpired(now), 'pg_timeout');
      }
      this.metrics.deletedExpired += removed;
      return removed;
    } catch (e) {
      this.metrics.backendErrors++;
      this.metrics.lastErrorCode = e.code || 'cleanup_failed';
      throw this._wrapErr('cleanup_failed', 'Vector cleanup failed', e);
    }
  }

  snapshot() {
    return {
      config: {
        backend: this.config.backend,
        maxQueryResults: this.config.maxQueryResults,
        maxRecords: this.config.maxRecords,
        defaultTtlMs: this.config.defaultTtlMs,
        backendTimeoutMs: this.config.backendTimeoutMs,
      },
      usage: { records: this.config.backend === 'memory' ? this._memory.length : null },
      state: { ready: this._ready, sqliteConnected: !!this._sqlite, pgConnected: !!this._pgPool },
      metrics: { ...this.metrics },
    };
  }

  toJSON() {
    if (this.config.backend !== 'memory') {
      return { version: 1, backend: this.config.backend, metrics: { ...this.metrics }, records: [] };
    }
    return { version: 1, backend: 'memory', records: this._memory, metrics: { ...this.metrics } };
  }

  fromJSON(raw) {
    if (!raw || typeof raw !== 'object') return;
    if (this.config.backend !== 'memory') return;
    const records = Array.isArray(raw.records) ? raw.records : [];
    this._memory = records.filter(r => r && typeof r === 'object' && typeof r.id === 'string' && typeof r.text === 'string').slice(-this.config.maxRecords);
    if (raw.metrics && typeof raw.metrics === 'object') this.metrics = { ...this.metrics, ...raw.metrics };
  }

  async _initSqlite() {
    let sqlite3;
    try {
      sqlite3 = require('sqlite3');
    } catch (e) {
      throw new VectorMemoryError('sqlite_dependency_missing', 'sqlite backend requested but sqlite3 is not installed', e);
    }
    const dbPath = this.config.sqlitePath;
    if (!dbPath) throw new VectorMemoryError('sqlite_path_missing', 'sqlite backend requires config.sqlitePath');

    this._sqlite = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, err => {
        if (err) return reject(new VectorMemoryError('sqlite_open_failed', err.message, err));
        resolve(db);
      });
    });

    await this._sqliteRun(`CREATE TABLE IF NOT EXISTS ${this._safeTable()} (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding_json TEXT, metadata_json TEXT, ts INTEGER NOT NULL, expires_at INTEGER)`);
    await this._sqliteRun(`CREATE INDEX IF NOT EXISTS idx_${this._safeTable()}_expires ON ${this._safeTable()}(expires_at)`);
    await this._sqliteRun(`CREATE INDEX IF NOT EXISTS idx_${this._safeTable()}_ts ON ${this._safeTable()}(ts)`);
  }

  async _initPostgres() {
    const conn = this.config.pg?.connectionString;
    if (!conn) throw new VectorMemoryError('pg_connection_missing', 'pg backend requires pg.connectionString');
    let Pool;
    try {
      ({ Pool } = require('pg'));
    } catch (e) {
      throw new VectorMemoryError('pg_dependency_missing', 'pg backend requested but pg dependency is missing', e);
    }

    this._pgPool = new Pool({
      connectionString: conn,
      ssl: this.config.pg?.ssl ? { rejectUnauthorized: false } : undefined,
      max: 4,
      idleTimeoutMillis: 15_000,
    });

    const t = this._safeTable();
    await this._pgQuery(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding_json JSONB, metadata_json JSONB, ts BIGINT NOT NULL, expires_at BIGINT)`);
    await this._pgQuery(`CREATE INDEX IF NOT EXISTS idx_${t}_expires ON ${t}(expires_at)`);
    await this._pgQuery(`CREATE INDEX IF NOT EXISTS idx_${t}_ts ON ${t}(ts)`);
  }

  _sqliteRun(sql, params = []) {
    return new Promise((resolve, reject) => {
      this._sqlite.run(sql, params, function onRun(err) {
        if (err) return reject(new VectorMemoryError('sqlite_run_failed', err.message, err));
        resolve(this.changes || 0);
      });
    });
  }

  _sqliteAll(sql, params = []) {
    return new Promise((resolve, reject) => {
      this._sqlite.all(sql, params, (err, rows) => {
        if (err) return reject(new VectorMemoryError('sqlite_query_failed', err.message, err));
        resolve(rows || []);
      });
    });
  }

  async _sqliteInsert({ id, text, embedding, metadata, expiresAt }) {
    const sql = `INSERT INTO ${this._safeTable()} (id, text, embedding_json, metadata_json, ts, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text=excluded.text,
        embedding_json=excluded.embedding_json,
        metadata_json=excluded.metadata_json,
        ts=excluded.ts,
        expires_at=excluded.expires_at`;
    await this._sqliteRun(sql, [id, text, embedding ? JSON.stringify(embedding) : null, JSON.stringify(metadata || {}), Date.now(), expiresAt || null]);
    await this._sqliteTrimToMax();
  }

  async _sqliteRows(metadata, limit) {
    const rows = await this._sqliteAll(`SELECT id, text, embedding_json, metadata_json, ts, expires_at FROM ${this._safeTable()} WHERE (expires_at IS NULL OR expires_at > ?) ORDER BY ts DESC LIMIT ?`, [Date.now(), Math.max(limit, this.config.maxQueryResults)]);
    return rows.map(r => ({ id: r.id, text: r.text, embedding: this._safeJsonParse(r.embedding_json, null), metadata: this._safeJsonParse(r.metadata_json, {}), ts: Number(r.ts) || Date.now(), expiresAt: Number(r.expires_at) || null })).filter(r => !metadata || this._metadataMatch(r.metadata, metadata));
  }

  async _sqliteDeleteExpired(now) {
    return this._sqliteRun(`DELETE FROM ${this._safeTable()} WHERE expires_at IS NOT NULL AND expires_at <= ?`, [now]);
  }

  async _sqliteTrimToMax() {
    const rows = await this._sqliteAll(`SELECT id FROM ${this._safeTable()} ORDER BY ts DESC LIMIT -1 OFFSET ?`, [this.config.maxRecords]);
    if (!rows.length) return;
    const ids = rows.map(r => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const ph = chunk.map(() => '?').join(',');
      await this._sqliteRun(`DELETE FROM ${this._safeTable()} WHERE id IN (${ph})`, chunk);
    }
  }

  async _pgQuery(sql, params = []) {
    try {
      return await this._pgPool.query(sql, params);
    } catch (e) {
      throw new VectorMemoryError('pg_query_failed', e.message, e);
    }
  }

  async _pgInsert({ id, text, embedding, metadata, expiresAt }) {
    const t = this._safeTable();
    await this._pgQuery(`INSERT INTO ${t} (id, text, embedding_json, metadata_json, ts, expires_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         text=EXCLUDED.text,
         embedding_json=EXCLUDED.embedding_json,
         metadata_json=EXCLUDED.metadata_json,
         ts=EXCLUDED.ts,
         expires_at=EXCLUDED.expires_at`, [id, text, embedding ? JSON.stringify(embedding) : null, JSON.stringify(metadata || {}), Date.now(), expiresAt || null]);
    await this._pgTrimToMax();
  }

  async _pgRows(metadata, limit) {
    const t = this._safeTable();
    const rows = (await this._pgQuery(`SELECT id, text, embedding_json, metadata_json, ts, expires_at FROM ${t} WHERE (expires_at IS NULL OR expires_at > $1) ORDER BY ts DESC LIMIT $2`, [Date.now(), Math.max(limit, this.config.maxQueryResults)])).rows || [];
    const mapped = rows.map(r => ({ id: r.id, text: r.text, embedding: Array.isArray(r.embedding_json) ? r.embedding_json : this._safeJsonParse(r.embedding_json, null), metadata: r.metadata_json || {}, ts: Number(r.ts) || Date.now(), expiresAt: Number(r.expires_at) || null }));
    return mapped.filter(r => !metadata || this._metadataMatch(r.metadata, metadata));
  }

  async _pgDeleteExpired(now) {
    const t = this._safeTable();
    const res = await this._pgQuery(`DELETE FROM ${t} WHERE expires_at IS NOT NULL AND expires_at <= $1`, [now]);
    return res.rowCount || 0;
  }

  async _pgTrimToMax() {
    const t = this._safeTable();
    await this._pgQuery(`DELETE FROM ${t} WHERE id IN (SELECT id FROM ${t} ORDER BY ts DESC OFFSET $1)`, [this.config.maxRecords]);
  }

  async _initChroma() {
    const cfg = this.config.chromadb;
    if (!cfg.apiKey)  throw new VectorMemoryError('chroma_key_missing',  'chromadb backend requires chromadb.apiKey / ZOMB_CHROMA_API_KEY');
    if (!cfg.tenant)  throw new VectorMemoryError('chroma_tenant_missing','chromadb backend requires chromadb.tenant / ZOMB_CHROMA_TENANT');

    let ChromaClient;
    try {
      ({ ChromaClient } = require('chromadb'));
    } catch (e) {
      throw new VectorMemoryError('chroma_dependency_missing', 'chromadb backend requires the chromadb npm package', e);
    }

    this._chromaClient = new ChromaClient({
      path : cfg.path,
      auth : { provider: 'token', credentials: cfg.apiKey, tokenHeaderType: 'X_CHROMA_TOKEN' },
      tenant  : cfg.tenant,
      database: cfg.database,
    });

    // getOrCreateCollection — cosine distance, no server-side embedding function
    // (we supply our own embeddings via OllamaEmbeddingProvider)
    this._chromaCollection = await this._chromaClient.getOrCreateCollection({
      name    : cfg.collection,
      metadata: { 'hnsw:space': 'cosine' },
      embeddingFunction: null,
    });
  }

  async _chromaInsert({ id, text, embedding, metadata, expiresAt }) {
    const meta = {
      ...(metadata || {}),
      _ts       : Date.now(),
      _expiresAt: expiresAt || 0,
    };
    const addArgs = {
      ids      : [id],
      documents: [text],
      metadatas: [meta],
    };
    if (Array.isArray(embedding) && embedding.length > 0) {
      addArgs.embeddings = [embedding];
    }
    await this._chromaCollection.upsert(addArgs);
  }

  async _chromaQuery({ text, embedding, metadata, limit }) {
    const queryArgs = { nResults: limit };
    if (Array.isArray(embedding) && embedding.length > 0) {
      queryArgs.queryEmbeddings = [embedding];
    } else {
      queryArgs.queryTexts = [text];
    }
    if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
      // Build ChromaDB where clause — only simple equality filters
      const where = {};
      for (const [k, v] of Object.entries(metadata)) {
        if (k.startsWith('_')) continue;
        where[k] = { '$eq': v };
      }
      if (Object.keys(where).length > 0) queryArgs.where = where;
    }

    const res = await this._chromaCollection.query(queryArgs);
    if (!res?.ids?.[0]) return [];

    const ids       = res.ids[0]       || [];
    const docs      = res.documents[0] || [];
    const metas     = res.metadatas[0] || [];
    const distances = res.distances?.[0] || [];

    return ids.map((id, i) => ({
      id,
      text    : docs[i]  || '',
      metadata: metas[i] || {},
      ts      : Number(metas[i]?._ts) || Date.now(),
      score   : 1 - (distances[i] || 0), // cosine distance → similarity
    }));
  }

  async _chromaDeleteExpired(now) {
    // Query all records where _expiresAt > 0 AND _expiresAt <= now
    try {
      const res = await this._chromaCollection.get({
        where: { '_expiresAt': { '$gt': 0, '$lte': now } },
        limit: this.config.cleanupBatchSize,
      });
      const expiredIds = res?.ids || [];
      if (expiredIds.length > 0) {
        await this._chromaCollection.delete({ ids: expiredIds });
      }
      return expiredIds.length;
    } catch (_) {
      return 0;
    }
  }

  _validateRecordInput(id, text, metadata) {
    if (!id || typeof id !== 'string') throw new VectorMemoryError('invalid_id', 'id must be non-empty string');
    if (!text || typeof text !== 'string') throw new VectorMemoryError('invalid_text', 'text must be non-empty string');
    if (metadata != null && typeof metadata !== 'object') throw new VectorMemoryError('invalid_metadata', 'metadata must be object or null');
  }

  _memoryRows(metadata) {
    const now = Date.now();
    return this._memory.filter(r => !(r.expiresAt && r.expiresAt <= now)).filter(r => !metadata || this._metadataMatch(r.metadata, metadata));
  }

  _boundMemoryRecords() {
    if (this._memory.length <= this.config.maxRecords) return;
    this._memory.splice(0, this._memory.length - this.config.maxRecords);
  }

  async _embed(text) {
    if (!this.embeddingProvider || typeof this.embeddingProvider.embed !== 'function') {
      this.metrics.fallbackEmbeddings++;
      return this._fallbackEmbed(text);
    }
    const emb = await this.embeddingProvider.embed(text);
    if (!Array.isArray(emb) || emb.length === 0) throw new VectorMemoryError('invalid_embedding_vector', 'embedding provider returned invalid vector');
    return emb;
  }

  _fallbackEmbed(text) {
    const out = new Array(32).fill(0);
    const words = String(text).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      let h = 0;
      for (let j = 0; j < w.length; j++) h = ((h << 5) - h + w.charCodeAt(j)) | 0;
      out[Math.abs(h) % out.length] += 1;
    }
    return out;
  }

  _metadataMatch(recordMeta, filterMeta) {
    if (!filterMeta || typeof filterMeta !== 'object') return true;
    const m = recordMeta || {};
    for (const [k, v] of Object.entries(filterMeta)) {
      if (m[k] !== v) return false;
    }
    return true;
  }

  _score(queryText, queryEmbedding, row) {
    if (Array.isArray(queryEmbedding) && Array.isArray(row.embedding) && queryEmbedding.length === row.embedding.length) {
      return this._cosine(queryEmbedding, row.embedding);
    }
    const q = new Set(String(queryText).toLowerCase().split(/\s+/).filter(Boolean));
    const r = new Set(String(row.text).toLowerCase().split(/\s+/).filter(Boolean));
    if (!q.size || !r.size) return 0;
    let hit = 0;
    for (const w of q) if (r.has(w)) hit++;
    return hit / Math.max(q.size, r.size);
  }

  _cosine(a, b) {
    let dot = 0; let na = 0; let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const av = Number(a[i]) || 0;
      const bv = Number(b[i]) || 0;
      dot += av * bv;
      na += av * av;
      nb += bv * bv;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  _safeTable() {
    const t = String(this.config.tableName || 'zomb_vector_memory');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) {
      throw new VectorMemoryError('invalid_table_name', `Unsafe table name: ${t}`);
    }
    return t;
  }

  _safeJsonParse(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  }

  async _withTimeout(promise, timeoutCode) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.metrics.backendTimeouts++;
        reject(new VectorMemoryError(timeoutCode, `Vector backend operation timed out after ${this.config.backendTimeoutMs}ms`));
      }, this.config.backendTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _wrapErr(code, msg, err) {
    if (err instanceof VectorMemoryError) return err;
    return new VectorMemoryError(code, msg + (err?.message ? `: ${err.message}` : ''), err);
  }
}

module.exports = VectorMemoryAdapter;
module.exports.VectorMemoryError = VectorMemoryError;
