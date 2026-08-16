'use strict';

const http  = require('http');
const { spawn } = require('child_process');

/**
 * OllamaClient — all communication with the local Ollama AI server.
 *
 * Manages:
 * - HTTP requests to localhost:11434
 * - Model availability checks with auto-start fallback
 * - Chat completions and raw generation
 * - aiAvailable flag used by the rest of the bot
 */
class OllamaClient {
  /**
   * @param {Object} aiConfig  — AI_CONFIG from config/zomb.js (merged with systemPrompt)
   * @param {Object} logger    — Logger instance
   */
  constructor(aiConfig, logger) {
    this.config     = aiConfig;
    this.log        = logger;
    this.available  = false;
    this.modelWarm  = false;
  }

  // ── Low-level HTTP ────────────────────────────────────────────────────────

  /**
   * Make a raw HTTP request to Ollama.
   * @param {string} endpoint  e.g. '/api/chat'
   * @param {string} method    'GET' | 'POST'
   * @param {Object|null} body JSON body for POST
   * @param {number|null} customTimeout ms override
   * @returns {Promise<Object>} Parsed JSON response
   */
  request(endpoint, method = 'POST', body = null, customTimeout = null) {
    return new Promise((resolve, reject) => {
      // Ollama on Windows sets OLLAMA_HOST=0.0.0.0 (bind address, not a connectable target).
      // Also: localhost resolves to ::1 on Node 17+ but Ollama only listens on IPv4.
      // Normalise: strip protocol → fix host → ensure port → rebuild clean URL.
      let rawHost = (this.config.host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
      if (!rawHost) rawHost = '127.0.0.1:11434';
      rawHost = rawHost.replace(/^(0\.0\.0\.0|localhost)(?=:|$)/i, '127.0.0.1');
      if (!/:\d+$/.test(rawHost)) rawHost += ':11434';
      const base = 'http://' + rawHost;
      const url  = new URL(endpoint, base);

      const options = {
        hostname : url.hostname,
        port     : url.port || 11434,
        path     : url.pathname,
        method,
        headers  : { 'Content-Type': 'application/json' },
        timeout  : customTimeout || this.config.timeoutMs || 60000,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (_) {
            // Handle streaming responses — parse last complete JSON line
            const lines = data.trim().split('\n').filter(l => l.trim());
            if (lines.length > 0) {
              try { resolve(JSON.parse(lines[lines.length - 1])); }
              catch (e2) { reject(new Error('Failed to parse Ollama response')); }
            } else {
              reject(new Error('Empty Ollama response'));
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timed out')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ── Availability & startup ────────────────────────────────────────────────

  async _tryStartOllama() {
    return new Promise((resolve) => {
      try {
        const proc = spawn('ollama', ['serve'], {
          detached   : true,
          stdio      : 'ignore',
          windowsHide: true,
          shell      : false,
        });
        proc.on('error', (err) => {
          this.log?.warn(`Could not start Ollama: ${err.message}`);
        });
        proc.unref();
        this.log?.info('Ollama not running — started "ollama serve" in background. Waiting...');
        resolve(true);
      } catch (e) {
        this.log?.warn(`Could not start Ollama: ${e.message}. Start it manually.`);
        resolve(false);
      }
    });
  }

  async checkAvailable() {
    const tryCheck = async () => {
      const result = await this.request('/api/tags', 'GET', null, 5000);
      if (!result || !result.models) return false;

      const modelNames = result.models.map(m => m.name);
      this.log?.info(`Ollama available. Models: ${modelNames.join(', ')}`);
      this.available = true;

      // Verify chat model, fall back if missing
      const hasModel = modelNames.some(n =>
        n === this.config.model || n.startsWith(this.config.model.split(':')[0])
      );
      if (!hasModel) {
        this.log?.warn(`Chat model "${this.config.model}" not found. Available: ${modelNames.join(', ')}`);
        const hasFallback = modelNames.some(n =>
          n === this.config.fallbackModel || n.startsWith(this.config.fallbackModel.split(':')[0])
        );
        if (hasFallback) {
          this.log?.info(`Using fallback model: ${this.config.fallbackModel}`);
          this.config.model = this.config.fallbackModel;
        }
      } else {
        this.log?.info(`Chat model: ${this.config.model}`);
      }

      // Verify fast classifier model
      const hasFast = modelNames.some(n =>
        n === this.config.fastModel || n.startsWith((this.config.fastModel || '').split(':')[0])
      );
      if (!hasFast) {
        this.log?.warn(`Fast model "${this.config.fastModel}" not found — using chat model`);
        this.config.fastModel = this.config.model;
      } else {
        this.log?.info(`Fast model: ${this.config.fastModel}`);
      }

      return true;
    };

    try {
      if (await tryCheck()) return true;
    } catch (e) { this.log?.warn(`Ollama initial check failed: ${e.message}`); }

    try {
      await this._tryStartOllama();
      await new Promise(r => setTimeout(r, 10000)); // give Ollama 10s to bind
      if (await tryCheck()) return true;
    } catch (_) { /* ignore */ }

    this.log?.warn('Ollama not available. AI features disabled. Start Ollama and restart ZomB.');
    this.available = false;
    return false;
  }

  // ── Chat completion ───────────────────────────────────────────────────────

  /**
   * Send messages to Ollama /api/chat.
   * @param {Array}  messages  — [{ role, content }, ...]
   * @param {string} model     — model name override (optional)
   * @param {number} timeout   — ms override
   * @returns {Promise<string>} assistant reply text
   */
  async chat(messages, model, timeout, overrides = {}) {
    const resp = await this.request('/api/chat', 'POST', {
      model  : model || this.config.model,
      messages,
      stream : false,
      options: {
        num_predict    : overrides.num_predict    ?? this.config.maxTokens    ?? 200,
        temperature    : overrides.temperature    ?? this.config.temperature  ?? 0.85,
        repeat_penalty : overrides.repeat_penalty ?? this.config.repeatPenalty ?? 1.3,
        repeat_last_n  : 128,
        ...(overrides.stop ? { stop: overrides.stop } : {}),
      },
    }, timeout || this.config.timeoutMs);

    return (resp.message?.content || '').trim();
  }

  /**
   * Raw single-turn generation via /api/generate.
   * Used for background tasks (class gen, self-reflect, etc.)
   * @param {string} prompt
   * @param {number} maxTokens
   * @param {string} model     — optional model override
   * @returns {Promise<string>}
   */
  async generate(prompt, maxTokens = 200, model) {
    const resp = await this.request('/api/generate', 'POST', {
      model  : model || this.config.model,
      prompt,
      stream : false,
      options: { num_predict: maxTokens, temperature: 0.9 },
    }, 20000);
    return (resp.response || '').trim();
  }

  /**
   * Fast classifier call using fastModel (llama3.2:1b or fallback).
   */
  async classify(prompt, maxTokens = 100) {
    return this.generate(prompt, maxTokens, this.config.fastModel || this.config.model);
  }

  /**
   * Chat with adaptive generation controls based on message context type.
   *
   * Context profiles (overridden by roomPolicy if provided):
   *   banter — quick banter / very short messages: 60 tokens, temp 0.92
   *   normal — standard reply: 100 tokens, temp 0.85
   *   deep   — question / explanation / direct ask: 150 tokens, temp 0.80
   *   drift  — drift/loop cooldown mode: 80 tokens, temp 0.70
   *
   * @param {Array}  messages
   * @param {string} contextType  'banter' | 'normal' | 'deep' | 'drift'
   * @param {Object} roomPolicy   per-room config overrides { maxTokens, temperature, repeatPenalty }
   * @returns {Promise<string>}
   */
  async chatAdaptive(messages, contextType = 'normal', roomPolicy = {}) {
    const PROFILES = {
      banter : { num_predict:  60, temperature: 0.92 },
      normal : { num_predict: 100, temperature: 0.85 },
      deep   : { num_predict: 150, temperature: 0.80 },
      drift  : { num_predict:  80, temperature: 0.70 },
    };
    const base = PROFILES[contextType] || PROFILES.normal;
    // Always stop at first sentence-terminator — forces one complete thought then halts.
    // Previously banter-only; extended to all context types because at 12-token budget,
    // 'normal' and 'deep' also produce multi-clause garbage when no stop seq is applied.
    // dolphin3:8b outputs one continuous line (no internal newlines), so ['\n'] never fired.
    return this.chat(messages, null, null, {
      num_predict    : roomPolicy.maxTokens    ?? base.num_predict,
      temperature    : roomPolicy.temperature  ?? base.temperature,
      repeat_penalty : roomPolicy.repeatPenalty ?? roomPolicy.repeat_penalty ?? this.config.repeatPenalty ?? 1.3,
      stop           : ['.', '!', '?'],
    });
  }
}

module.exports = OllamaClient;
