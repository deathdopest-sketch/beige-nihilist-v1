'use strict';

/**
 * CommandRouter — parses commands, checks permissions + cooldowns, routes to handlers.
 *
 * Architecture:
 *  - `register(cmd, handler, opts)` — register a command with tier/cooldown
 *  - `route(roomName, nick, text, ctx)` — parse prefix, dispatch, return response
 *  - Aliases map for common typos/shortcuts
 *  - Tier system: 'owner' | 'mod' | 'user' (default user)
 *  - Cooldowns per (user, command) pair; owners bypass
 */
class CommandRouter {
  /**
   * @param {Object} identitySystem — IdentitySystem instance
   * @param {Object} logger         — Logger instance
   */
  constructor(identitySystem, logger) {
    this.identity = identitySystem;
    this.log      = logger;
    this.prefix   = '.';

    /** @type {Map<string, {handler, tier, cooldown}>} */
    this._commands  = new Map();
    /** @type {Map<string, string>} alias → canonical */
    this._aliases   = new Map();
    /** @type {Map<string, number>} `nick:cmd` → last used timestamp */
    this._cooldowns = new Map();

    this._registerBuiltins();
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a command handler.
   * @param {string|string[]} names   — command name(s); first is canonical
   * @param {Function} handler        — async (ctx) => string|null
   * @param {Object} opts
   *   opts.tier     'owner'|'mod'|'user' (default 'user')
   *   opts.cooldown  ms (default 5000)
   */
  register(names, handler, opts = {}) {
    const list      = Array.isArray(names) ? names : [names];
    const canonical = list[0];
    const entry     = {
      handler,
      tier    : opts.tier     || 'user',
      cooldown: opts.cooldown || 5000,
    };
    this._commands.set(canonical, entry);
    for (let i = 1; i < list.length; i++) {
      this._aliases.set(list[i], canonical);
    }
  }

  /** Register only aliases (e.g. for typos → existing canonical). */
  alias(from, to) { this._aliases.set(from, to); }

  // ── Routing ───────────────────────────────────────────────────────────────

  /**
   * Parse and route a command.
   * @param {string} roomName
   * @param {string} nick
   * @param {string} text      — raw message text starting with prefix
   * @param {Object} ctx       — extra context passed to handler (bot, page, etc.)
   * @returns {Promise<string|null>} response to send, or null if handler queued directly
   */
  async route(roomName, nick, text, ctx = {}) {
    if (!text.startsWith(this.prefix)) return null;

    const parts = text.slice(this.prefix.length).trim().split(/\s+/);
    let   raw   = parts[0].toLowerCase();
    const cmd   = this._aliases.get(raw) || raw;
    const args  = parts.slice(1);

    const entry = this._commands.get(cmd);
    if (!entry) return null; // unknown command — caller may pass to game system

    // Permission check — use pre-resolved role from ctx if available (avoids redundant identity lookup)
    if (!this._checkPermission(nick, entry.tier, roomName, ctx.role)) {
      this.log?.debug(`[${roomName}] ${nick} denied: .${cmd} (tier:${entry.tier})`);
      return `nah, ${nick}.`;
    }

    // Cooldown check
    if (!this._checkCooldown(nick, cmd, entry.cooldown, ctx.role)) {
      return `slow down, ${nick}.`;
    }

    try {
      const result = await entry.handler({ roomName, nick, args, cmd, text, ...ctx });
      return result || null;
    } catch (e) {
      this.log?.error(`Command .${cmd} error: ${e.message}`);
      return `broke: ${e.message}`;
    }
  }

  // ── Permission helpers ────────────────────────────────────────────────────

  _checkPermission(nick, tier, roomName, resolvedRole = null) {
    if (tier === 'user') return true;
    const isOwner = resolvedRole
      ? (resolvedRole === 'owner' || resolvedRole === 'admin')
      : this.identity.isOwner(nick);
    if (tier === 'owner') return isOwner;
    if (tier === 'mod') return isOwner; // extend if you add a mod list
    return false;
  }

  _checkCooldown(nick, cmd, cooldownMs, resolvedRole = null) {
    const isOwner = resolvedRole
      ? (resolvedRole === 'owner' || resolvedRole === 'admin')
      : this.identity.isOwner(nick);
    if (isOwner) return true;
    const key     = `${nick.toLowerCase()}:${cmd}`;
    const last    = this._cooldowns.get(key) || 0;
    const now     = Date.now();
    if (now - last < cooldownMs) return false;
    this._cooldowns.set(key, now);
    return true;
  }

  // ── Built-in commands (minimal set — rest registered by ZomBBot) ──────────

  _registerBuiltins() {
    // Typo aliases from the monolith
    this.alias('cwnsus', 'census');
    this.alias('cenus',  'census');
    this.alias('censu',  'census');
    this.alias('yt',     'play');
    this.alias('youtube','play');
    this.alias('vol',    'volume');
    this.alias('close',  'stop');
    // NOTE: 'pause' is a real command (pause video), NOT an alias for 'stop'
    this.alias('jam',    'music');
    this.alias('ytp',    'ytplaylist');
    this.alias('alt',    'alternative');
    this.alias('heavy',  'metal');
    this.alias('80s',    'synthwave');
    this.alias('retro',  'synthwave');
    this.alias('rap',    'hiphop');
    this.alias('screamo','posthardcore');
    this.alias('classic','classicrock');
    this.alias('pf',     'petfight');
    this.alias('st',     'stitch');
  }

  /** Expose command names for help listings. */
  list() {
    return [...this._commands.keys()];
  }
}

module.exports = CommandRouter;
