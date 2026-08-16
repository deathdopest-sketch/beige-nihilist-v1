'use strict';

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const http  = require('http');
const net   = require('net');
const { spawn, execSync } = require('child_process');

const puppeteerExtra  = require('puppeteer-extra');
const StealthPlugin   = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

/**
 * BrowserManager — Chrome lifecycle and Puppeteer page management.
 *
 * Two launch modes:
 *  - Docker   (DOCKER=true) — puppeteerExtra.launch() with Xvfb already running
 *  - Windows  (default)    — spawn system Chrome with CDP, connect via puppeteer.connect()
 *
 * Windows Defender note: system Chrome MUST be tried first — bundled puppeteer
 * Chrome gets killed by Defender. The CDP retry loop handles Chrome's self-respawn.
 */
class BrowserManager {
  /**
   * @param {Object} config   — CONFIG from config/zomb.js
   * @param {Object} logger   — Logger instance
   */
  constructor(config, logger) {
    this.config = config;
    this.log    = logger;

    this.browser         = null;
    this._browserProcess = null;
    this._debugPort      = config.CDP_DEBUG_PORT || 9222;
    this._userDataDir    = path.join(os.tmpdir(), 'spackle-bot-chrome');
  }

  // ── TCP + HTTP readiness probes ───────────────────────────────────────────

  _waitForPort(port, host, timeoutMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const sock = new net.Socket();
        sock.setTimeout(500);
        sock.once('connect', () => { sock.destroy(); resolve(); });
        sock.once('error',   () => { sock.destroy(); if (Date.now() < deadline) setTimeout(attempt, 300); else reject(new Error(`Port ${port} not open after ${timeoutMs}ms`)); });
        sock.once('timeout', () => { sock.destroy(); if (Date.now() < deadline) setTimeout(attempt, 300); else reject(new Error(`Port ${port} timed out`)); });
        sock.connect(port, host);
      };
      attempt();
    });
  }

  /** Wait until Chrome's DevTools HTTP endpoint is responding (not just TCP open). */
  _waitForHttpReady(port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else if (Date.now() < deadline) setTimeout(attempt, 500);
          else reject(new Error(`DevTools endpoint not ready after ${timeoutMs}ms`));
        });
        req.setTimeout(1500, () => { req.destroy(); if (Date.now() < deadline) setTimeout(attempt, 500); else reject(new Error('DevTools timed out')); });
        req.on('error', () => { if (Date.now() < deadline) setTimeout(attempt, 500); else reject(new Error('DevTools unreachable')); });
      };
      attempt();
    });
  }

  _checkDebugPort(port) {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.setTimeout(1000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  // ── Chrome path resolution ────────────────────────────────────────────────

  _findChromePath() {
    let bundledChrome = null;
    try { bundledChrome = require('puppeteer').executablePath(); } catch (_) {}

    const localAppData = process.env.LOCALAPPDATA || '';
    const candidates = [
      // System Chrome first — Defender trusts it
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      this.config.BROWSER_PATH,
      bundledChrome,
    ].filter(p => { try { return p && fs.existsSync(p); } catch { return false; } });

    const seen  = new Set();
    const unique = candidates.filter(p => { if (seen.has(p)) return false; seen.add(p); return true; });
    if (unique.length === 0) throw new Error('No browser found. Install Chrome or Brave.');
    return unique;
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  async launch() {
    this.log?.info('Launching browser...');

    // ── Docker mode ────────────────────────────────────────────────────────
    // Uses Xvfb virtual display (set up by docker-entrypoint.sh, DISPLAY=:99)
    // headless:false with Xvfb is more compatible with StumbleChat than headless:'new'
    if (process.env.DOCKER === 'true') {
      const args = [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
        '--disable-infobars', '--window-size=1366,768', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--remote-debugging-port=9222',
        '--disable-features=VizDisplayCompositor',
      ];
      this.browser = await puppeteerExtra.launch({
        executablePath  : process.env.BROWSER_PATH || '/usr/bin/chromium',
        headless        : false,
        args,
        defaultViewport : { width: 1366, height: 768 },
        env             : { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
        protocolTimeout : 90000,  // 90s — camera slideshow makes the renderer slow
      });
      this.log?.info('Browser ready (Docker mode)');
      return;
    }

    // ── Windows CDP mode ───────────────────────────────────────────────────
    const debugPort = this._debugPort;
    const alreadyOpen = await this._checkDebugPort(debugPort);

    if (alreadyOpen) {
      this.log?.info(`Debug port ${debugPort} already open — reusing existing browser`);
    } else {
      // Clear stale lock files and Chrome session-restore data
      for (const lf of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
        try {
          const p = path.join(this._userDataDir, lf);
          if (fs.existsSync(p)) { fs.unlinkSync(p); this.log?.debug(`Cleared lock: ${lf}`); }
        } catch (_) {}
      }
      // Delete previous-session tab lists so Chrome doesn't reopen old rooms on launch
      for (const sf of ['Last Session', 'Last Tabs', 'Current Session', 'Current Tabs']) {
        try {
          const p = path.join(this._userDataDir, 'Default', sf);
          if (fs.existsSync(p)) { fs.unlinkSync(p); this.log?.debug(`Cleared session file: ${sf}`); }
        } catch (_) {}
      }

      // Kill any lingering Chrome process that holds a lock on our user data dir.
      // This happens when the bot crashes/exits without cleanly closing Chrome (detached process).
      try {
        const udEscaped = this._userDataDir.replace(/'/g, "''");
        execSync(
          `powershell -NoProfile -Command "` +
          `Get-WmiObject Win32_Process -Filter \\"Name='chrome.exe'\\" | ` +
          `Where-Object { $_.CommandLine -like '*${udEscaped}*' } | ` +
          `ForEach-Object { $_.Terminate() }"`,
          { timeout: 5000, stdio: 'pipe' }
        );
        this.log?.debug('[BrowserManager] Cleared stale Chrome processes for this profile');
      } catch (_) { /* no matching processes or WMI unavailable — that's fine */ }

      const chromePaths = this._findChromePath();
      const browserArgs = [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${this._userDataDir}`,
        '--no-sandbox', '--disable-setuid-sandbox',
        // NOTE: --disable-gpu intentionally omitted on Windows — it breaks canvas captureStream
        '--no-first-run', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars', '--window-size=1366,768',
        '--no-default-browser-check', '--disable-extensions',
        '--disable-web-security', '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',             // auto-grant camera/mic permission dialogs
        '--use-fake-device-for-media-stream',         // register a fake device so enumerateDevices isn't empty
        '--no-session-restore',                       // prevent Chrome restoring tabs from last session
        '--disable-session-crashed-bubble',           // suppress "Chrome didn't shut down correctly" prompt
        '--disable-background-timer-throttling',      // prevent setInterval/setTimeout slowdown in background tabs
        '--disable-renderer-backgrounding',           // keep background tabs at full CPU priority
        '--disable-backgrounding-occluded-windows',   // don't throttle when window is hidden/covered
        '--disable-background-media-suspend',         // don't suspend media (video) in background tabs
        'about:blank',
      ];
      if (this.config.HEADLESS) browserArgs.push('--headless=new');

      let spawned = false;
      for (const cp of chromePaths) {
        this.log?.info(`Spawning: ${cp}`);
        try {
          this._browserProcess = spawn(cp, browserArgs, {
            detached   : true,
            stdio      : 'ignore',
            windowsHide: false,
          });
          this._browserProcess.unref();
          this._browserProcess.on('error', e => this.log?.error('Browser spawn error: ' + e.message));
          await this._waitForHttpReady(debugPort, 45000);
          this.log?.info(`Browser ready on port ${debugPort}: ${cp}`);
          spawned = true;
          break;
        } catch (e) {
          this.log?.warn(`Spawn failed (${cp}): ${e.message.split('\n')[0]}`);
        }
      }
      if (!spawned) throw new Error('Could not spawn any browser. Tried: ' + chromePaths.join(', '));
    }

    // Give DevTools HTTP server a moment to fully stabilise
    await new Promise(r => setTimeout(r, 2000));

    // CDP connect — retry loop (Chrome may briefly die and respawn on Windows)
    let connectErr;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await this._waitForHttpReady(debugPort, 15000);
        this.browser = await puppeteerExtra.connect({
          browserURL    : `http://127.0.0.1:${debugPort}`,
          defaultViewport: null,
        });
        connectErr = null;
        break;
      } catch (e) {
        connectErr = e;
        this.log?.warn(`Connect attempt ${attempt}/8 failed: ${e.message.split('\n')[0]} — retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (connectErr) throw connectErr;

    this.log?.info('Browser connected via CDP');

    // Clear stale tabs — keep one blank tab alive so Chrome accepts Target.createTarget.
    // Closing ALL tabs leaves Chrome with 0 pages and it refuses to open new ones.
    try {
      const stale = await this.browser.pages();
      if (stale.length > 0) {
        await stale[0].goto('about:blank').catch(() => {});
        await Promise.all(stale.slice(1).map(p => p.close().catch(() => {})));
        if (stale.length) this.log?.info(`Cleared ${stale.length} stale tab(s) — kept 1 blank`);
      }
    } catch (_) {}
  }

  // ── Page helpers ──────────────────────────────────────────────────────────

  /** Open a new page and apply stealth overrides + virtual camera intercept. */
  async newPage() {
    const videoBase64s = await this._preloadCameraFiles();
    const page = await this.browser.newPage();
    await page.evaluateOnNewDocument((videoBase64s) => {
      // ── Stealth ────────────────────────────────────────────────────────────
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      if (!window.chrome) window.chrome = { runtime: {} };
      const origQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (p) =>
        p.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(p);

      // ── Decode pre-loaded files to blob URLs (synchronous, before any page script) ──
      // Matches Lilly's pattern: video is live from the first getUserMedia call,
      // not 8+ seconds later when Node-side enableCamera() eventually fires.
      window._zombPreloadedUrls = (videoBase64s || []).map(function(item) {
        try {
          const bytes = atob(item.b64);
          const arr   = new Uint8Array(bytes.length);
          for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
          return { url: URL.createObjectURL(new Blob([arr], { type: item.mime })), mime: item.mime };
        } catch (_) { return null; }
      }).filter(Boolean);

      // ── Virtual camera (canvas-based MediaStream) ───────────────────────
      // Intercepts getUserMedia so StumbleChat gets our canvas stream instead
      // of a real camera. _zombSlideshow drives what's painted on the canvas.
      (function _installZombCam() {
        if (!navigator.mediaDevices) return;

        // Override enumerateDevices — StumbleChat calls this to populate its device picker.
        // Without a fake entry the picker is empty and #media-broadcast stays disabled.
        navigator.mediaDevices.enumerateDevices = async function() {
          return [
            { deviceId: 'zomb-video-001', groupId: 'zomb-group-001', kind: 'videoinput',  label: 'ZomB Virtual Camera'  },
            { deviceId: 'zomb-audio-001', groupId: 'zomb-group-001', kind: 'audioinput',  label: 'ZomB Virtual Mic'     },
            { deviceId: 'default',        groupId: 'zomb-group-001', kind: 'audiooutput', label: 'ZomB Virtual Speaker' },
          ];
        };

        const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

        function _zombInitCanvas() {
          if (window._zombCanvas) return;
          const cv = document.createElement('canvas');
          cv.width = 640; cv.height = 480;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#0a0205';
          ctx.fillRect(0, 0, 640, 480);
          ctx.fillStyle = '#cc2200';
          ctx.font = 'bold 56px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('\uD83E\uDDDF', 320, 200); // 🧟
          ctx.fillStyle = '#884422';
          ctx.font = 'bold 28px Arial';
          ctx.fillText('ZomBv2', 320, 300);
          window._zombCanvas = cv;
          window._zombCtx    = ctx;
          window._zombStream = cv.captureStream(25);

          window._zombSlideshow = {
            _vid       : null,
            _drawTimer : null,
            _blobUrl   : null, // track active blob URL so we can revoke when swapping
            setImage: function(url) {
              if (this._drawTimer) { clearInterval(this._drawTimer); this._drawTimer = null; }
              if (this._vid) { this._vid.pause(); if (this._vid.parentNode) this._vid.parentNode.removeChild(this._vid); this._vid = null; }
              if (this._blobUrl) { try { URL.revokeObjectURL(this._blobUrl); } catch(_){} this._blobUrl = null; }
              if (url.startsWith('blob:')) this._blobUrl = url;
              const img = new Image();
              img.onload = () => { window._zombCtx.drawImage(img, 0, 0, 640, 480); };
              img.onerror = () => {
                const c = window._zombCtx;
                c.fillStyle = '#0a0205'; c.fillRect(0, 0, 640, 480);
                c.fillStyle = '#884422'; c.font = 'bold 24px Arial';
                c.textAlign = 'center'; c.textBaseline = 'middle';
                c.fillText('ZomB', 320, 240);
              };
              img.src = url;
            },
            setVideo: function(url) {
              if (this._drawTimer) { clearInterval(this._drawTimer); this._drawTimer = null; }
              if (this._blobUrl) { try { URL.revokeObjectURL(this._blobUrl); } catch(_){} this._blobUrl = null; }
              if (this._vid && this._vid.parentNode) { this._vid.parentNode.removeChild(this._vid); }
              window._zombVidStream = null;
              if (url.startsWith('blob:')) this._blobUrl = url;
              const vid = document.createElement('video');
              vid.src = url; vid.muted = true; vid.playsInline = true; vid.loop = true;
              // Full size off-screen — 1x1px causes Chrome to skip frame decoding entirely
              vid.width = 640; vid.height = 480;
              vid.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:640px;height:480px;opacity:0;pointer-events:none;';
              this._vid = vid;
              const self = this;
              vid.addEventListener('ended', () => {
                if (window._zombOnVideoEnded) window._zombOnVideoEnded();
              });
              function _doAppend() {
                if (document.body) {
                  document.body.appendChild(vid);
                  vid.play().then(() => {
                    // Direct captureStream() is far more reliable than canvas drawImage —
                    // Chrome handles frame scheduling, no manual draw loop needed.
                    if (vid.captureStream) {
                      window._zombVidStream = vid.captureStream(25);
                    }
                    // Also draw to canvas (canvas stream fallback + canvas liveness check)
                    self._drawTimer = setInterval(() => {
                      if (vid !== self._vid) { clearInterval(self._drawTimer); self._drawTimer = null; return; }
                      if (window._zombCtx && !vid.paused && !vid.ended && vid.readyState >= 2) {
                        window._zombCtx.drawImage(vid, 0, 0, 640, 480);
                      }
                    }, 40);
                  }).catch((e) => {
                    console.warn('[ZomBCam] video play() rejected:', e && e.message);
                    if (window._zombOnVideoEnded) window._zombOnVideoEnded();
                  });
                } else {
                  document.addEventListener('DOMContentLoaded', _doAppend, { once: true });
                }
              }
              _doAppend();
            },
          };

          // Start pre-loaded video/gif immediately — camera shows content before getUserMedia fires
          const _first = window._zombPreloadedUrls && window._zombPreloadedUrls[0];
          if (_first) {
            if (_first.mime === 'image/gif') {
              window._zombSlideshow.setImage(_first.url);
            } else {
              window._zombSlideshow.setVideo(_first.url);
            }
          }
        }

        // Pre-initialise canvas immediately so _zombSlideshow exists before
        // getUserMedia fires — without this, setVideo() silently no-ops because
        // the guard `if (!window._zombSlideshow) return` kills the injection.
        setTimeout(_zombInitCanvas, 50);

        navigator.mediaDevices.getUserMedia = async function(constraints) {
          if (constraints && constraints.video) {
            _zombInitCanvas();
            // Prefer direct video captureStream (real decoded frames) over canvas stream.
            // _zombVidStream is set once vid.play() resolves in setVideo().
            const vidStream = window._zombVidStream;
            const vidTrack = vidStream && vidStream.active
              ? vidStream.getVideoTracks().find(t => t.readyState === 'live')
              : null;
            const videoTrack = vidTrack || window._zombStream.getVideoTracks()[0];
            if (constraints.audio) {
              try {
                const actx = new AudioContext();
                const dest  = actx.createMediaStreamDestination();
                const osc   = actx.createOscillator();
                const gain  = actx.createGain();
                gain.gain.value = 0; // silent
                osc.connect(gain); gain.connect(dest); osc.start();
                return new MediaStream([videoTrack, dest.stream.getAudioTracks()[0]]);
              } catch (_) {}
            }
            return new MediaStream([videoTrack]);
          }
          return _origGUM(constraints);
        };
      })();
    }, videoBase64s);
    return page;
  }

  /**
   * Pre-load camera source files as base64 so they can be decoded to blob URLs
   * inside evaluateOnNewDocument before the page scripts ever run.
   * Returns [{b64, mime}] array, max 2 files, max 20 MB each.
   */
  async _preloadCameraFiles() {
    const candidates = [];
    if (this.config.CAMERA_VIDEO)                      candidates.push(this.config.CAMERA_VIDEO);
    if (this.config.CAMERA_GIF_PATH)                   candidates.push(this.config.CAMERA_GIF_PATH);
    if (Array.isArray(this.config.CAMERA_GIF_PATHS))   candidates.push(...this.config.CAMERA_GIF_PATHS);

    const MAX_BYTES = 20 * 1024 * 1024;
    const result = [];
    for (const p of candidates) {
      if (result.length >= 2) break;
      if (!p) continue;
      try {
        if (!fs.existsSync(p)) continue;
        const stat = fs.statSync(p);
        if (stat.size > MAX_BYTES) {
          this.log?.warn(`[BrowserManager] Skipping ${path.basename(p)} — ${(stat.size / 1e6).toFixed(1)} MB > 20 MB limit`);
          continue;
        }
        const ext  = path.extname(p).toLowerCase();
        const mime = ext === '.gif' ? 'image/gif' : ext === '.webm' ? 'video/webm' : 'video/mp4';
        const b64  = fs.readFileSync(p).toString('base64');
        result.push({ b64, mime });
        this.log?.info(`[BrowserManager] Pre-loaded camera file: ${path.basename(p)} (${(stat.size / 1e6).toFixed(1)} MB, ${mime})`);
      } catch (e) {
        this.log?.warn(`[BrowserManager] Could not pre-load ${p}: ${e.message}`);
      }
    }
    return result;
  }

  /** Gracefully close the browser (if we own the process). */
  async close() {
    try { if (this.browser) await this.browser.close(); } catch (_) {}
    this.browser = null;
  }

  /** True if browser is connected and not closed. */
  get isConnected() {
    return !!(this.browser && this.browser.isConnected());
  }
}

module.exports = BrowserManager;
