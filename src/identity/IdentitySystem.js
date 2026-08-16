'use strict';

/**
 * IdentitySystem — resolves who a nick/handle actually is.
 *
 * Six-layer lookup (in priority order):
 *  1. Registered handle → direct authoritative match
 *  2. Legacy owner handle → migrate to Death
 *  3. Bootstrap nick → known alias, bind handle if available
 *  4. Account name → permanent StumbleChat account name
 *  5. Reverse nick→handle lookup from usernameToHandleMap
 *  6. Unknown user → role:'user'
 */
class IdentitySystem {
  /**
   * @param {Object} identityRegistry  — The IDENTITY_REGISTRY object from config
   * @param {Object} storage           — StorageManager instance
   * @param {Object} logger            — Logger instance
   */
  constructor(identityRegistry, storage, logger) {
    this.registry = identityRegistry;
    this.storage  = storage;
    this.log      = logger;

    // Runtime lookup maps — rebuilt after any handle change
    this._nickToIdentity    = new Map();
    this._handleToIdentity  = new Map();
    this._accountToIdentity = new Map();

    // Legacy owner handles (old flat array format in JSON)
    this._legacyOwnerHandles = new Set();

    // Provided externally by BotCore — nick → numeric handle
    this.usernameToHandleMap = new Map();

    this._rebuildLookups();
  }

  // ── Lookup table maintenance ──────────────────────────────────────────────

  _rebuildLookups() {
    this._nickToIdentity.clear();
    this._handleToIdentity.clear();
    this._accountToIdentity.clear();

    for (const [name, entry] of Object.entries(this.registry)) {
      for (const nick of (entry.bootstrapNicks || [])) {
        this._nickToIdentity.set(nick.toLowerCase(), name);
      }
      for (const h of (entry.handles || new Set())) {
        this._handleToIdentity.set(String(h), name);
      }
      if (entry.accountName) {
        this._accountToIdentity.set(entry.accountName.toLowerCase(), name);
      }
    }
  }

  // ── Core resolution ───────────────────────────────────────────────────────

  /**
   * Resolve a nick + optional handle + optional username to { identity, role }.
   * username is the permanent StumbleChat account name (never changes, unlike nick/handle).
   * @param {string} nick
   * @param {string|null} handle
   * @param {string|null} [username]  — StumbleChat account name from JOIN/userlist events
   * @returns {{ identity: string|null, role: string }}
   */
  identify(nick, handle, username) {
    const h      = handle   ? String(handle)         : null;
    const lower  = nick     ? nick.toLowerCase()     : null;
    const uLower = username ? username.toLowerCase() : null;

    // 1. Handle lookup
    if (h && this._handleToIdentity.has(h)) {
      const name = this._handleToIdentity.get(h);
      return { identity: name, role: this.registry[name].role };
    }

    // 2. Legacy handle migration
    if (h && this._legacyOwnerHandles.has(h)) {
      this._bindHandle('Death', h);
      this._legacyOwnerHandles.delete(h);
      return { identity: 'Death', role: 'owner' };
    }

    // 3. Account name via username field — most reliable non-handle signal.
    //    Checked before bootstrap nick so a registry member is recognised even
    //    when using an unfamiliar display nick.
    if (uLower && this._accountToIdentity.has(uLower)) {
      const name = this._accountToIdentity.get(uLower);
      if (h && !this.registry[name].handles.has(h)) {
        this._bindHandle(name, h);
      }
      return { identity: name, role: this.registry[name].role };
    }

    // 4. Bootstrap nick — if username is provided and doesn't match accountName,
    //    the nick is being spoofed; reject. Only trust when username is absent.
    if (lower && this._nickToIdentity.has(lower)) {
      const name  = this._nickToIdentity.get(lower);
      const entry = this.registry[name];
      if (uLower && entry.accountName && uLower !== entry.accountName.toLowerCase()) {
        return { identity: null, role: 'user' };
      }
      const knownHandles = entry.handles?.size || 0;
      if (h && knownHandles > 0 && !entry.handles.has(h)) {
        this.log?.info(
          `[Identity] New handle for "${name}" — binding ${h} (${knownHandles} handles on record)`
        );
      }
      if (h && !entry.handles.has(h)) {
        this._bindHandle(name, h);
      }
      return { identity: name, role: entry.role };
    }

    // 5. Account name via display nick (nick happens to equal accountName in registry)
    if (lower && this._accountToIdentity.has(lower)) {
      const name = this._accountToIdentity.get(lower);
      if (h && !this.registry[name].handles.has(h)) {
        this._bindHandle(name, h);
      }
      return { identity: name, role: this.registry[name].role };
    }

    // 6. Reverse nick→handle lookup
    if (lower && !h) {
      const mapped = this.usernameToHandleMap.get(lower);
      if (mapped && this._handleToIdentity.has(mapped)) {
        const name = this._handleToIdentity.get(mapped);
        return { identity: name, role: this.registry[name].role };
      }
    }

    // 7. Unknown
    return { identity: null, role: 'user' };
  }

  /** Convenience — is this nick an owner or admin? */
  isOwner(username) {
    if (!username) return false;
    const handle = this.usernameToHandleMap.get(username.toLowerCase()) || null;
    const { role } = this.identify(username, handle);
    return role === 'owner' || role === 'admin';
  }

  /** Get the role string for a nick. */
  getRole(username) {
    if (!username) return 'user';
    const handle = this.usernameToHandleMap.get(username.toLowerCase()) || null;
    return this.identify(username, handle).role;
  }

  /**
   * Permanently add a nick to an identity's bootstrap list so it is recognised
   * in future sessions even without a handle match.
   * Persists via _saveHandles so it survives restarts.
   */
  addBootstrapNick(identityName, nick) {
    const entry = this.registry[identityName];
    if (!entry) return false;
    const lower = nick.toLowerCase();
    if (!entry.bootstrapNicks) entry.bootstrapNicks = [];
    if (entry.bootstrapNicks.includes(lower)) return false;
    entry.bootstrapNicks.push(lower);
    this._nickToIdentity.set(lower, identityName);
    this._saveHandles();
    this.log?.info(`Bootstrap nick added: "${nick}" → ${identityName}`);
    return true;
  }

  // ── Handle binding ────────────────────────────────────────────────────────

  _bindHandle(identityName, handle) {
    const entry = this.registry[identityName];
    if (!entry) return;
    if (!entry.handles) entry.handles = new Set();
    if (entry.handles.has(handle)) return;
    // Cap at 50 handles per identity — drop oldest (first-inserted) when over limit
    if (entry.handles.size >= 50) {
      const oldest = entry.handles.values().next().value;
      entry.handles.delete(oldest);
    }
    entry.handles.add(handle);
    this._rebuildLookups();
    this._saveHandles();
    this.log?.info(`Handle bound: ${handle} → ${identityName} (${entry.role})`);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  saveHandles() { this._saveHandles(); }

  _saveHandles() {
    try {
      const identities = {};
      for (const [name, entry] of Object.entries(this.registry)) {
        const hasHandles = entry.handles && entry.handles.size > 0;
        // Also save any runtime-added bootstrap nicks (beyond what's in config)
        const configNicks  = this.registry[name]?._configBootstrapNicks || [];
        const runtimeNicks = (entry.bootstrapNicks || []).filter(n => !configNicks.includes(n));
        if (hasHandles || runtimeNicks.length > 0) {
          identities[name] = {
            handles        : hasHandles ? [...entry.handles] : [],
            runtimeNicks,
          };
        }
      }
      this.storage.write(this.storage.paths.ownerHandles, { _version: 3, identities });
    } catch (e) {
      this.log?.warn('IdentitySystem._saveHandles failed: ' + e.message);
    }
  }

  loadHandles() {
    try {
      const data = this.storage.read(this.storage.paths.ownerHandles);
      if (!data || !Object.keys(data).length) return;

      // Old format: flat array of owner handles
      if (Array.isArray(data)) {
        this.log?.info(`Migrating ${data.length} legacy owner handle(s)`);
        this._legacyOwnerHandles = new Set(data.map(String));
        this._saveHandles();
        return;
      }

      // v2 format: { _version: 2, identities: { "Death": ["984145", ...] } }
      if (data._version === 2 && data.identities) {
        let total = 0;
        for (const [name, handles] of Object.entries(data.identities)) {
          const entry = this.registry[name];
          if (!entry) continue;
          if (!entry.handles) entry.handles = new Set();
          const capped = handles.slice(-50);
          for (const h of capped) { entry.handles.add(String(h)); total++; }
        }
        this._rebuildLookups();
        this.log?.info(`Loaded ${total} handle(s) for ${Object.keys(data.identities).length} identity(ies)`);
      }

      // v3 format: { _version: 3, identities: { "Death": { handles: [...], runtimeNicks: [...] } } }
      if (data._version === 3 && data.identities) {
        let totalH = 0, totalN = 0;
        for (const [name, saved] of Object.entries(data.identities)) {
          const entry = this.registry[name];
          if (!entry) continue;
          // Snapshot config nicks so we know which are runtime-added
          if (!entry._configBootstrapNicks) {
            entry._configBootstrapNicks = [...(entry.bootstrapNicks || [])];
          }
          if (!entry.handles) entry.handles = new Set();
          for (const h of (saved.handles || []).slice(-50)) { entry.handles.add(String(h)); totalH++; }
          for (const n of (saved.runtimeNicks || [])) {
            if (!entry.bootstrapNicks) entry.bootstrapNicks = [];
            if (!entry.bootstrapNicks.includes(n)) { entry.bootstrapNicks.push(n); totalN++; }
          }
        }
        this._rebuildLookups();
        this.log?.info(`Loaded ${totalH} handle(s) and ${totalN} runtime nick(s)`);
      }
    } catch (e) {
      this.log?.warn('IdentitySystem.loadHandles failed: ' + e.message);
    }
  }
}

module.exports = IdentitySystem;
