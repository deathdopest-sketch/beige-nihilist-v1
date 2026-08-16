'use strict';

/**
 * UserProfiles — persistent per-user behavioral profiles.
 *
 * Profiles are keyed by canonical identity name (lowercased) — so all aliases
 * for the same person (Death / KillaKen / 666kk666) share one profile.
 * Unknown users are keyed by username.toLowerCase().
 *
 * Each profile contains:
 *   username, firstSeen, lastSeen,
 *   messageCount, interactionCount, engagementScore,
 *   personalityScores, socialMetrics, behavior, psychProfile,
 *   previousUsernames
 *
 * Merging: pickPsychProfile / psychProfileRichness prefer the richer game psych block.
 */

/**
 * Heuristic richness score for psychProfile objects (game / AI analysis blocks).
 * Used when merging two records so the more informative profile wins.
 */
function psychProfileRichness(p) {
  if (!p || typeof p !== 'object') return 0;
  let s = 0;
  const label = String(p.characterLabel || '').trim();
  if (label && label.toUpperCase() !== 'NEUTRAL') s += 25;
  s += (Number(p.totalRed) || 0) + (Number(p.totalGreen) || 0);
  const sumObj = (o) => {
    if (!o || typeof o !== 'object') return 0;
    return Object.values(o).reduce((a, v) => a + (Number(v) || 0), 0);
  };
  s += sumObj(p.redScores) + sumObj(p.greenScores);
  if (Array.isArray(p.matchedProfiles) && p.matchedProfiles.length) s += p.matchedProfiles.length * 4;
  if (p.lastAnalyzed) s += 1;
  // Bonus for live reap analysis (analyzed message count)
  if (p.analyzed > 0) s += Math.min(30, p.analyzed);
  return s;
}

/**
 * Pick the better psychProfile for merging (richer, or newer if tied).
 */
function pickPsychProfile(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ra = psychProfileRichness(a);
  const rb = psychProfileRichness(b);
  if (rb > ra) return b;
  if (ra > rb) return a;
  return (Number(b.lastAnalyzed) || 0) > (Number(a.lastAnalyzed) || 0) ? b : a;
}

class UserProfiles {
  /**
   * @param {Object} storage        — StorageManager instance
   * @param {Object} identitySystem — IdentitySystem instance (for canonical key resolution)
   * @param {Object} logger         — Logger instance
   */
  constructor(storage, identitySystem, logger) {
    this.storage  = storage;
    this.identity = identitySystem;
    this.log      = logger;

    /** @type {Map<string, Object>} */
    this._profiles = new Map();
  }

  // ── Key resolution ────────────────────────────────────────────────────────

  /**
   * Canonical key — uses identity system to collapse aliases to one key.
   * e.g. "killaken", "KillaKen", "666kk666" → "death"
   */
  resolveKey(username) {
    if (!username) return 'unknown';
    const handle = this.identity?.usernameToHandleMap?.get(username.toLowerCase()) || null;
    const { identity } = this.identity?.identify(username, handle) || {};
    return identity ? identity.toLowerCase() : username.toLowerCase();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  get(username) {
    return this._profiles.get(this.resolveKey(username)) || null;
  }

  has(username) {
    return this._profiles.has(this.resolveKey(username));
  }

  getOrCreate(username) {
    const key = this.resolveKey(username);
    if (!this._profiles.has(key)) {
      this._profiles.set(key, this._blank(username));
    }
    return this._profiles.get(key);
  }

  /**
   * Merge partial data into a profile.
   * @param {string} username
   * @param {Object} data  Partial profile fields
   */
  update(username, data) {
    const profile = this.getOrCreate(username);
    Object.assign(profile, data);
    profile.lastSeen = Date.now();
  }

  delete(username) {
    this._profiles.delete(this.resolveKey(username));
  }

  all() {
    return this._profiles;
  }

  // ── Profile template ──────────────────────────────────────────────────────

  _blank(username) {
    return {
      username,
      firstSeen        : Date.now(),
      lastSeen         : Date.now(),
      messageCount     : 0,
      interactionCount : 0,
      engagementScore  : 0,
      personalityScores: {},
      socialMetrics    : { responsiveness: 0, chattiness: 0, helpfulness: 0 },
      behavior         : {
        avgMsgLength   : 0,
        totalMsgLength : 0,
        emojiCount     : 0,
        questionCount  : 0,
        commandCount   : 0,
        capsCount      : 0,
        linkCount      : 0,
        sessionCount   : 0,
        lastSessionStart: null,
        timeOfDayBuckets: { morning: 0, afternoon: 0, evening: 0, latenight: 0 },
        topTraits      : [],
        toxicityFlags  : 0,
        positivityFlags: 0,
        visitDays      : [],
        streak         : 0,
        longestStreak  : 0,
      },
      psychProfile     : null,
      previousUsernames: [],
    };
  }

  // ── Merge ─────────────────────────────────────────────────────────────────

  /**
   * Deep-merge src profile into dest (modifies dest in place).
   * Used when two profiles are discovered to belong to the same person.
   */
  merge(dest, src) {
    dest.messageCount     = (dest.messageCount     || 0) + (src.messageCount     || 0);
    dest.interactionCount = (dest.interactionCount || 0) + (src.interactionCount || 0);
    dest.engagementScore  = Math.min(100, (dest.engagementScore || 0) + (src.engagementScore || 0));

    // Personality scores — sum
    const srcPS = src.personalityScores || {};
    dest.personalityScores = dest.personalityScores || {};
    for (const [trait, score] of Object.entries(srcPS)) {
      dest.personalityScores[trait] = (dest.personalityScores[trait] || 0) + score;
    }

    // Social metrics — average
    const ds = dest.socialMetrics || {};
    const ss = src.socialMetrics  || {};
    dest.socialMetrics = {
      responsiveness: Math.round(((ds.responsiveness || 0) + (ss.responsiveness || 0)) / 2),
      chattiness    : Math.round(((ds.chattiness     || 0) + (ss.chattiness     || 0)) / 2),
      helpfulness   : Math.round(((ds.helpfulness    || 0) + (ss.helpfulness    || 0)) / 2),
    };

    // Behavior block — sum most counters
    const db = dest.behavior || {};
    const sb = src.behavior  || {};
    const totalMsgs = dest.messageCount;
    dest.behavior = {
      avgMsgLength   : totalMsgs > 0
        ? Math.round(((db.avgMsgLength || 0) * (dest.messageCount - (src.messageCount || 0)) +
                      (sb.avgMsgLength || 0) * (src.messageCount || 0)) / totalMsgs) : 0,
      totalMsgLength : (db.totalMsgLength || 0) + (sb.totalMsgLength || 0),
      emojiCount     : (db.emojiCount    || 0) + (sb.emojiCount    || 0),
      questionCount  : (db.questionCount || 0) + (sb.questionCount || 0),
      commandCount   : (db.commandCount  || 0) + (sb.commandCount  || 0),
      capsCount      : (db.capsCount     || 0) + (sb.capsCount     || 0),
      linkCount      : (db.linkCount     || 0) + (sb.linkCount     || 0),
      sessionCount   : (db.sessionCount  || 0) + (sb.sessionCount  || 0),
      lastSessionStart: db.lastSessionStart || sb.lastSessionStart || null,
      timeOfDayBuckets: {
        morning  : (db.timeOfDayBuckets?.morning   || 0) + (sb.timeOfDayBuckets?.morning   || 0),
        afternoon: (db.timeOfDayBuckets?.afternoon || 0) + (sb.timeOfDayBuckets?.afternoon || 0),
        evening  : (db.timeOfDayBuckets?.evening   || 0) + (sb.timeOfDayBuckets?.evening   || 0),
        latenight: (db.timeOfDayBuckets?.latenight || 0) + (sb.timeOfDayBuckets?.latenight || 0),
      },
      topTraits      : db.topTraits || sb.topTraits || [],
      toxicityFlags  : (db.toxicityFlags  || 0) + (sb.toxicityFlags  || 0),
      positivityFlags: (db.positivityFlags|| 0) + (sb.positivityFlags|| 0),
      visitDays      : [...new Set([...(db.visitDays || []), ...(sb.visitDays || [])])],
      streak         : Math.max(db.streak        || 0, sb.streak        || 0),
      longestStreak  : Math.max(db.longestStreak || 0, sb.longestStreak || 0),
    };

    // Psych profile — keep the richer / newer structured analysis
    dest.psychProfile = pickPsychProfile(dest.psychProfile, src.psychProfile);

    // Timestamps
    if (src.firstSeen && (!dest.firstSeen || src.firstSeen < dest.firstSeen)) dest.firstSeen = src.firstSeen;
    if (src.lastSeen  && (!dest.lastSeen  || src.lastSeen  > dest.lastSeen))  dest.lastSeen  = src.lastSeen;

    // Previous usernames — union
    dest.previousUsernames = dest.previousUsernames || [];
    for (const n of [...(src.previousUsernames || []), src.username]) {
      if (n && !dest.previousUsernames.includes(n) && n !== dest.username) {
        dest.previousUsernames.push(n);
      }
    }

    return dest;
  }

  // ── Identity migration ────────────────────────────────────────────────────

  /**
   * After loading, re-key profiles saved under alias nicks.
   * e.g. "killaken" entry → merged into "death".
   */
  migrateKeys() {
    const migrations = [];
    for (const [key, profile] of this._profiles) {
      const canonical = this.resolveKey(profile.username || key);
      if (canonical !== key) migrations.push({ oldKey: key, canonical, profile });
    }
    for (const { oldKey, canonical, profile } of migrations) {
      if (this._profiles.has(canonical)) {
        this.merge(this._profiles.get(canonical), profile);
        this.log?.info(`Profile merged: '${oldKey}' → '${canonical}'`);
      } else {
        this._profiles.set(canonical, profile);
        this.log?.info(`Profile re-keyed: '${oldKey}' → '${canonical}'`);
      }
      this._profiles.delete(oldKey);
    }
    if (migrations.length > 0) {
      this.log?.info(`Profile migration complete: ${migrations.length} profile(s) consolidated`);
    }
  }

  // ── Nick-change helper ────────────────────────────────────────────────────

  onNickChange(oldNick, newNick) {
    const oldKey = this.resolveKey(oldNick);
    const newKey = this.resolveKey(newNick);
    if (oldKey === newKey) return;

    const profile = this._profiles.get(oldKey);
    if (!profile) return;

    if (this._profiles.has(newKey)) {
      this.merge(this._profiles.get(newKey), profile);
    } else {
      profile.username = newNick;
      if (!profile.previousUsernames.includes(oldNick)) profile.previousUsernames.push(oldNick);
      this._profiles.set(newKey, profile);
    }
    this._profiles.delete(oldKey);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  save() {
    const data = {};
    for (const [key, profile] of this._profiles) {
      data[key] = profile;
    }
    this.storage.write(this.storage.paths.interactions, data);
  }

  load() {
    const data = this.storage.read(this.storage.paths.interactions, {});
    this._profiles.clear();
    for (const [key, profile] of Object.entries(data)) {
      this._profiles.set(key, profile);
    }
    this.migrateKeys();
    this.log?.info(`Loaded ${this._profiles.size} user profile(s)`);
  }
}

module.exports = UserProfiles;
module.exports.psychProfileRichness = psychProfileRichness;
module.exports.pickPsychProfile = pickPsychProfile;