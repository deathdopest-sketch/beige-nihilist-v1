'use strict';

/**
 * OllamaEmbeddingProvider
 * Generates embeddings via Ollama's /api/embeddings endpoint.
 * Best model: nomic-embed-text (pull with: ollama pull nomic-embed-text)
 * Falls back gracefully — caller handles null return.
 */
class OllamaEmbeddingProvider {
  constructor({ host, model = 'nomic-embed-text', timeoutMs = 10000 } = {}) {
    // Same normalization as OllamaClient: 0.0.0.0 is a bind addr, not a target.
    let h = (host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
    if (!h) h = '127.0.0.1:11434';
    h = h.replace(/^(0\.0\.0\.0|localhost)(?=:|$)/i, '127.0.0.1');
    if (!/:\d+$/.test(h)) h += ':11434';
    this.host      = 'http://' + h;
    this.model     = model;
    this.timeoutMs = timeoutMs;
    this._available = null; // null = not checked yet
  }

  async embed(text) {
    if (!text || typeof text !== 'string') return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.host}/api/embeddings`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ model: this.model, prompt: text.slice(0, 2048) }),
        signal : ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const emb = data.embedding;
      if (!Array.isArray(emb) || emb.length === 0) throw new Error('Empty embedding returned');
      this._available = true;
      return emb;
    } catch (e) {
      if (this._available !== false) {
        // Only log the first failure to avoid spam
        console.warn(`[OllamaEmbed] ${this.model} unavailable: ${e.message}`);
      }
      this._available = false;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  get isAvailable() { return this._available === true; }
}

module.exports = OllamaEmbeddingProvider;
