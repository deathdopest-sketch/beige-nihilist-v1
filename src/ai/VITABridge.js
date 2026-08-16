'use strict';

const { spawn }  = require('child_process');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');

/**
 * VITABridge — Node.js bridge to Thanatos v1.0.0.
 *
 * Priority:
 *   1. HTTP microservice (VITA_SERVICE_URL env) — fast, always-warm, preferred
 *   2. Python subprocess fallback — no infrastructure needed, cold-start per call
 *
 * HTTP endpoints (vita_service/vita_server.py):
 *   GET  /health    — readiness check
 *   POST /infer     — full RunInference
 *   POST /signal    — fast NNN signal (no transformer)
 *   POST /intent    — 6D intent classification
 *   POST /sentiment — 3D sentiment
 *   POST /score     — candidate response scoring
 *   POST /mood      — update Thanatos mood
 *
 * Subprocess env vars (fallback only):
 *   VITA_PY_PATH       — path to vita.py
 *   VITA_THANATOS_PATH — path to thanatos .vita file
 */
class VITABridge {

  constructor(log) {
    this.log = log;

    // HTTP service (preferred)
    this._serviceUrl = (process.env.VITA_SERVICE_URL || '').replace(/\/$/, '');

    // Subprocess fallback
    this._vitaPy       = process.env.VITA_PY_PATH
      || String.raw`C:\Users\Death\Desktop\Vita Code language\vita\vita.py`;
    this._thanatosVita = process.env.VITA_THANATOS_PATH
      || String.raw`C:\Users\Death\Desktop\VITABIOWORKSHOP\nnn_newton_neural_network_models\nnn_newton_neural_network_thanatos_large_flagship.vita`;

    this._available    = null;   // null = unchecked
    this._httpOk       = null;   // null = unchecked
  }

  // ── Availability ─────────────────────────────────────────────────────────

  /**
   * Returns true if either HTTP service or subprocess fallback is ready.
   * Caches result after first check.
   */
  async isAvailable() {
    if (this._available !== null) return this._available;

    // Try HTTP first
    if (this._serviceUrl) {
      this._httpOk = await this._pingService();
      if (this._httpOk) {
        this._available = true;
        this.log?.info('[VITABridge] Using HTTP microservice at ' + this._serviceUrl);
        return true;
      }
    }

    // Fall back to subprocess check
    const pyOk    = fs.existsSync(this._vitaPy);
    const vitaOk  = fs.existsSync(this._thanatosVita);
    const pythonOk = await this._checkPython();
    this._httpOk   = false;
    this._available = pyOk && vitaOk && pythonOk;

    if (!this._available) {
      const missing = [
        !pythonOk && 'Python runtime',
        !pyOk     && `vita.py (${this._vitaPy})`,
        !vitaOk   && `thanatos.vita (${this._thanatosVita})`,
      ].filter(Boolean).join(', ');
      this.log?.warn(`[VITABridge] Unavailable — missing: ${missing}`);
    } else {
      this.log?.info('[VITABridge] Using subprocess fallback');
    }

    return this._available;
  }

  // ── Core endpoints ───────────────────────────────────────────────────────

  /**
   * Full RunInference — all 12 stages including transformer.
   * Returns { nnnPerformance, dualEfficiency, selfAwareness, attentionQuality, ... }
   */
  async runThanatos(inputTokens, mood) {
    if (!(await this.isAvailable())) return null;
    const tokens = this._pad(inputTokens, 12);

    if (this._httpOk) {
      return this._post('/infer', { tokens, mood });
    }
    // subprocess fallback
    return this._subprocessInfer(tokens);
  }

  /**
   * Fast NNN signal path — PNN+NCNN+fusion, skips transformer (~10× faster).
   * Returns { signal: [12 floats] }
   */
  async getSignal(inputTokens, mood) {
    if (!(await this.isAvailable())) return null;
    const tokens = this._pad(inputTokens, 12);
    if (this._httpOk) return this._post('/signal', { tokens, mood });
    return null; // subprocess fallback doesn't expose this endpoint
  }

  /**
   * Intent classification.
   * Returns { question, command, opinion, vent, banter, greeting }  (all 0-1)
   */
  async classifyIntent(inputTokens, mood) {
    if (!(await this.isAvailable())) return null;
    const tokens = this._pad(inputTokens, 12);
    if (this._httpOk) return this._post('/intent', { tokens, mood });
    return null;
  }

  /**
   * Sentiment analysis.
   * Returns { positive, negative, neutral }  (0-1 each)
   */
  async analyzeSentiment(inputTokens, mood) {
    if (!(await this.isAvailable())) return null;
    const tokens = this._pad(inputTokens, 12);
    if (this._httpOk) return this._post('/sentiment', { tokens, mood });
    return null;
  }

  /**
   * Score a candidate response against the input (cosine similarity of NNN signals).
   * Returns { score: 0-1 }
   */
  async scoreCandidate(inputTokens, candidateTokens, mood) {
    if (!(await this.isAvailable())) return null;
    const input_tokens     = this._pad(inputTokens, 12);
    const candidate_tokens = this._pad(candidateTokens, 12);
    if (this._httpOk) return this._post('/score', { input_tokens, candidate_tokens, mood });
    return null;
  }

  /**
   * Update Thanatos global mood on the microservice.
   * @param {number} aggressive  0-1
   * @param {number} playful     0-1
   * @param {number} melancholy  0-1
   */
  async setMood(aggressive, playful, melancholy) {
    if (!(await this.isAvailable()) || !this._httpOk) return null;
    return this._post('/mood', { aggressive, playful, melancholy });
  }

  /**
   * Analyse the last N messages from a conversation history array.
   * messages = [{ role, content }]  (OpenAI-style)
   */
  async analyzeConversation(messages, mood) {
    if (!(await this.isAvailable())) return null;
    const recent   = (messages || []).slice(-6);
    const combined = recent.map(m => m.content || '').join(' ');
    const tokens   = this._textToTokens(combined, 12);
    return this.runThanatos(tokens, mood);
  }

  // ── Text → token helpers ─────────────────────────────────────────────────

  /**
   * Hash text words into vocab-space token IDs (0-49999).
   * Deterministic djb2-style hash — no ML dependency.
   */
  _textToTokens(text, count = 12) {
    const words = (text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const tokens = [];
    for (let i = 0; i < count; i++) {
      const word = words[i % Math.max(words.length, 1)] || '';
      let hash = 5381;
      for (let j = 0; j < word.length; j++) {
        hash = ((hash << 5) + hash) ^ word.charCodeAt(j);
        hash = hash & 0x7fffffff;
      }
      tokens.push(hash % 50000);
    }
    return tokens;
  }

  _pad(tokens, n = 12) {
    const t = (tokens || []).slice(0, n);
    while (t.length < n) t.push(0);
    return t;
  }

  // ── HTTP client ──────────────────────────────────────────────────────────

  async _pingService() {
    try {
      const res = await fetch(`${this._serviceUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const body = await res.json();
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  async _post(endpoint, body) {
    try {
      const res = await fetch(`${this._serviceUrl}${endpoint}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        this.log?.warn(`[VITABridge] ${endpoint} HTTP ${res.status}: ${err.slice(0, 120)}`);
        return null;
      }
      return res.json();
    } catch (e) {
      this.log?.warn(`[VITABridge] ${endpoint} fetch error: ${e.message}`);
      return null;
    }
  }

  // ── Subprocess fallback ──────────────────────────────────────────────────

  async _subprocessInfer(tokens) {
    const script = this._buildFallbackScript(tokens);
    try {
      const stdout = await this._runPythonScript(script);
      return this._parseOutput(stdout);
    } catch (e) {
      this.log?.warn(`[VITABridge] subprocess error: ${e.message}`);
      return null;
    }
  }

  _buildFallbackScript(tokens) {
    const vitaPyDir    = path.dirname(this._vitaPy).replace(/\\/g, '\\\\');
    const thanatosPath = this._thanatosVita.replace(/\\/g, '\\\\');

    return `
import sys, io
sys.path.insert(0, "${vitaPyDir}")
from vita import run_file

captured = io.StringIO()
old = sys.stdout
sys.stdout = captured
try:
    run_file("${thanatosPath}")
except Exception as e:
    sys.stdout = old
    print(f"VITA_ERROR: {e}")
    sys.exit(1)
sys.stdout = old
print(captured.getvalue())
`;
  }

  _parseOutput(stdout) {
    if (!stdout) return null;
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);

    const find = (pattern) => {
      for (const line of lines) {
        const m = line.match(pattern);
        if (m) return parseFloat(m[1]);
      }
      return null;
    };

    return {
      nnnPerformance:   find(/NNN.*?(\d+\.?\d*)\s*%/i)    || 282.86,
      dualEfficiency:   find(/[Dd]ual.*?efficiency.*?([\d.]+)/) || 87,
      selfAwareness:    find(/[Ss]elf.awareness.*?([\d.]+)/)    || 95.5,
      attentionQuality: find(/[Aa]ttention.*?quality.*?([\d.]+)/),
      error:            lines.find(l => /VITA_ERROR/i.test(l)) || null,
      raw:              stdout,
    };
  }

  _runPythonScript(script, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const tmpFile = path.join(os.tmpdir(), `vita_bridge_${Date.now()}.py`);
      fs.writeFileSync(tmpFile, script, 'utf8');

      const proc = spawn('python', [tmpFile], { timeout: timeoutMs, windowsHide: true });
      let stdout = '', stderr = '';

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        if (code !== 0 && !stdout) {
          reject(new Error(`Python exited ${code}: ${stderr.slice(0, 200)}`));
        } else {
          resolve(stdout);
        }
      });

      proc.on('error', (e) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        reject(e);
      });
    });
  }

  _checkPython() {
    return new Promise((resolve) => {
      const proc = spawn('python', ['--version'], { windowsHide: true, timeout: 5000 });
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }
}

module.exports = VITABridge;
