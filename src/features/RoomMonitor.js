'use strict';

/**
 * RoomMonitor — keeps each room alive.
 *
 * Two modes:
 *  1. WebSocket listener is active → DOM poll runs every 10s as fallback,
 *     but is skipped entirely if WS received a message within 60s.
 *  2. WS not active → DOM poll runs at CONFIG.MONITOR_INTERVAL (default 5s).
 *
 * Also handles:
 *  - Modal dismissal ("You really think you're smart", "joined on another device")
 *  - WS reconnect triggers if the listener dies
 */
class RoomMonitor {
  /**
   * @param {Object} logger       — Logger instance
   * @param {number} normalInterval — Poll interval when WS inactive (ms)
   * @param {number} wsFallbackInterval — Poll interval when WS active (ms)
   */
  constructor(logger, normalInterval = 5000, wsFallbackInterval = 10000) {
    this.log              = logger;
    this._normalInterval  = normalInterval;
    this._wsFallbackInterval = wsFallbackInterval;

    /** @type {Map<string, NodeJS.Timeout>} roomName → timer */
    this._timers     = new Map();
    /** @type {Map<string, Set<string>>} roomName → processed dedup keys */
    this._processed  = new Map();
  }

  // ── Start / stop per room ─────────────────────────────────────────────────

  /**
   * Start monitoring a room.
   * @param {string} roomName
   * @param {Object} room        — { page, wsListener }
   * @param {Function} onMessage — async (roomName, nick, text, handle) callback
   * @param {boolean} wsActive   — whether the WS listener is active
   */
  start(roomName, room, onMessage, wsActive = false) {
    this.stop(roomName); // clear any existing timer

    const interval = wsActive ? this._wsFallbackInterval : this._normalInterval;
    this.log?.info(`[${roomName}] Monitor started (${interval}ms, WS:${wsActive})`);

    const timer = setInterval(async () => {
      // Skip DOM poll when WS is healthy
      const lastWs = room.wsListener?.lastRecvMs || room._lastWsRecvMs || 0;
      if (Date.now() - lastWs < 60000) return;

      try {
        await this._pollChat(roomName, room.page, onMessage);
        await this._checkModals(roomName, room.page);
      } catch (e) {
        if (!e.message?.includes('Execution context was destroyed')) {
          this.log?.error(`[${roomName}] Monitor error: ${e.message}`);
        }
      }
    }, interval);

    this._timers.set(roomName, timer);
    if (!this._processed.has(roomName)) this._processed.set(roomName, new Set());
  }

  stop(roomName) {
    const timer = this._timers.get(roomName);
    if (timer) { clearInterval(timer); this._timers.delete(roomName); }
  }

  stopAll() {
    for (const [roomName] of this._timers) this.stop(roomName);
  }

  // ── DOM chat polling ──────────────────────────────────────────────────────

  async _pollChat(roomName, page, onMessage) {
    const messages = await page.$$eval(
      'div.message',
      (elements) => elements.slice(-20).map(el => {
        const nickEl   = el.querySelector('span.nickname');
        const msgEl    = el.querySelector('span.message.common');
        const userEl   = nickEl || el.querySelector('.username, .sender, [class*="nick"], strong, b');
        const contentEl = msgEl || el.querySelector('div.content, .content, .text, [class*="content"], span:last-child');
        const id = el.getAttribute('data-id') || el.getAttribute('id') || '';
        return {
          username: userEl   ? userEl.textContent.trim().replace(/[:\s]+$/, '') : '',
          content : contentEl ? contentEl.textContent.trim() : '',
          id,
        };
      }).filter(m => m.username && m.content && m.username !== m.content)
    ).catch(() => []);

    const processed = this._processed.get(roomName) || new Set();

    for (const msg of messages) {
      const key = `${msg.username}:${msg.content}:${msg.id}`;
      if (processed.has(key)) continue;
      processed.add(key);

      // Prune dedup set
      if (processed.size > 500) {
        const arr = [...processed];
        processed.clear();
        arr.slice(250).forEach(k => processed.add(k));
      }

      await onMessage(roomName, msg.username, msg.content, null);
    }
  }

  // ── Modal detection + dismissal ───────────────────────────────────────────

  async _checkModals(roomName, page) {
    try {
      const result = await page.evaluate(() => {
        // "Joined on another device" overlay — check first (no modal element)
        const bodyText = document.body?.innerText || '';
        if (bodyText.includes('joined on another device') || bodyText.includes('another tab')) {
          return 'session_conflict';
        }

        // Anti-bot modal: "#modal-back", "#modal", or any [id*="modal"] that is visible
        // and contains the known anti-bot phrases ("smart", "you really think", "automated", "attention")
        const modal = document.querySelector('#modal-back, #modal, [id*="modal"]');
        if (modal) {
          const style = window.getComputedStyle(modal);
          const hidden = style.display === 'none' || style.visibility === 'hidden';
          if (!hidden) {
            const lc = (modal.textContent || '').toLowerCase();
            const isAntiBotModal =
              lc.includes('smart') ||
              lc.includes('you really think') ||
              lc.includes('automated') ||
              lc.includes('attention');
            if (isAntiBotModal) {
              // Click the first visible button / label inside the modal
              const candidates = modal.querySelectorAll(
                '#modal-exit, button, input[type="button"], input[type="submit"], [role="button"], label'
              );
              for (const el of candidates) {
                const rect = el.getBoundingClientRect();
                const st   = window.getComputedStyle(el);
                if (rect.width > 0 && rect.height > 0 &&
                    st.display !== 'none' && st.visibility !== 'hidden') {
                  el.click();
                  return 'antibot_dismissed';
                }
              }
              // No clickable button — press Escape
              document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })
              );
              return 'antibot_escaped';
            }
          }
        }

        // Legacy challenge modal selector
        const challengeModal = document.querySelector('.challenge-modal, [class*="challenge"], #challenge-modal');
        if (challengeModal) {
          const btn = challengeModal.querySelector('button, .btn, [role="button"]');
          if (btn) { btn.click(); return 'challenge_dismissed'; }
        }

        return null;
      }).catch(() => null);

      if (result === 'antibot_dismissed' || result === 'antibot_escaped' || result === 'challenge_dismissed') {
        this.log?.warn(`[${roomName}] Dismissed anti-bot modal (${result})`);
      } else if (result === 'session_conflict') {
        this.log?.warn(`[${roomName}] Session conflict detected — triggering reconnect`);
        throw new Error('SESSION_CONFLICT');
      }
    } catch (e) {
      if (e.message !== 'SESSION_CONFLICT') return; // swallow DOM errors
      throw e;
    }
  }

  // ── Dedup helpers ─────────────────────────────────────────────────────────

  /** Manually mark a message as processed (e.g. when received via WS). */
  markProcessed(roomName, nick, content, id = '') {
    const key = `${nick}:${content}:${id}`;
    const set  = this._processed.get(roomName);
    if (set) set.add(key);
  }

  /** Clear dedup state for a room (e.g. on reconnect). */
  clearProcessed(roomName) {
    this._processed.set(roomName, new Set());
  }
}

module.exports = RoomMonitor;
