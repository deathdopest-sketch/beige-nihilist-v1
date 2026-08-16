'use strict';

// ─── Word banks ───────────────────────────────────────────────────────────────

const POS_WORDS = new Set(['good','great','awesome','amazing','love','happy','excellent','wonderful','fantastic','nice','cool','perfect','brilliant','best','beautiful','enjoy','fun','appreciate','glad','helpful','thanks','thank','sweet','solid','lit','fire','dope','legendary','epic','kind','smart','clever','genius','wise','interesting','valid','true','correct','right','agree']);
const NEG_WORDS = new Set(['bad','terrible','awful','hate','stupid','idiot','dumb','worst','sucks','boring','annoying','useless','garbage','trash','disgusting','ugly','pathetic','loser','cringe','horrible','broken','waste','disappointing','lame','weak','worthless','pointless','fail','failure','ridiculous','wrong','fake','lie','liar','fake','clown','fraud']);

const EMOTION_RE = {
  joy:     /\b(happy|happiness|excited|celebrate|thrilled|joy|yay|cheers|awesome|amazing|great|lol|lmao|haha|hehe|love|blessed|grateful|stoked|pumped)\b/i,
  sadness: /\b(sad|depressed|cry|crying|miss|lonely|hurt|pain|grief|empty|broken|tears|alone|upset|miserable|hopeless|lost|tired of)\b/i,
  anger:   /\b(angry|rage|furious|pissed|hate|mad|annoyed|frustrated|bullshit|raging|fuming|livid|sick of|fed up|infuriating)\b/i,
  fear:    /\b(scared|afraid|terrified|worried|anxious|nervous|panic|fear|dread|threat|paranoid|vulnerable)\b/i,
  love:    /\b(love|adore|cherish|heart|kiss|hug|care about|miss you|darling|my person|everything to me)\b/i,
  disgust: /\b(disgusting|gross|sick|vile|revolting|nasty|repulsive|filthy|putrid|horrible|repelled)\b/i,
};

const DIM_RE = {
  logical:       /\b(therefore|because|hence|implies|prove|evidence|logical|reasoning|deduce|conclude|it follows|if.{0,10}then)\b/i,
  emotional:     /\b(feel|feeling|heart|soul|emotionally|mood|vibe|emotions|deeply|genuinely hurts)\b/i,
  creative:      /\b(imagine|what if|idea|original|unique|create|build|design|art|concept|invent|innovate|dream up)\b/i,
  analytical:    /\b(data|stats|numbers|breakdown|analyze|compare|metrics|pattern|systematic|percentage|measurement|statistic)\b/i,
  intuitive:     /\b(gut feeling|gut says|instinct|just know|feeling tells|intuition|sixth sense|something tells me)\b/i,
  empathetic:    /\b(understand how|must be hard|that sucks|i hear you|feel for you|know what you.re going through|hard for (you|them)|tough situation)\b/i,
  philosophical: /\b(meaning|existence|purpose|truth|reality|consciousness|society|human nature|life is|universe|identity|why we)\b/i,
  practical:     /\b(how to|what do we do|fix|solution|practical|works|does it work|apply|step by step|implement|get it done)\b/i,
};

const HOSTILE_RE = /\b(fuck you|kill yourself|you('re| are) (an? )?(idiot|moron|loser|bitch|asshole|retard|stupid|waste)|die|go to hell|i hate you|piece of (shit|crap)|screw you)\b/i;
const THREAT_RE  = /\b(i('ll| will)|gonna|going to).{0,20}(hurt|kill|find you|attack|destroy|beat|end you)\b/i;
const DOXX_RE    = /\b(doxx|where (do )?you live|your address|phone number|find you|track you|locate)\b/i;

// ─── PsychAnalyzer ────────────────────────────────────────────────────────────

/**
 * PsychAnalyzer — real-time behavioral + psychological profiling.
 * Ported from ReapEyeBotV2 analytical capabilities, adapted for ZomB v3.0.
 *
 * Per-message: sentiment, 6 emotions, 8 personality dims, intent, authenticity, risk.
 * Per-room: social graph, conversation flow, conflict tracking, participation balance.
 *
 * All state is in-memory. No I/O, no dependencies.
 * Call observe() on every message; call getContextLine() for AI prompt injection.
 */
class PsychAnalyzer {
  constructor(config = {}) {
    this._maxRoomUsers   = config.maxRoomUsers   || 200;
    this._maxRoomHistory = config.maxRoomHistory || 50;
    /** @type {Map<string, UserState>} */
    this._users = new Map();
    /** @type {Map<string, RoomState>} */
    this._rooms = new Map();
  }

  // ── Main entry ──────────────────────────────────────────────────────────────

  /**
   * Observe a chat message. Updates per-user and per-room state.
   * @param {string} username
   * @param {string} text
   * @param {string} room
   */
  observe(username, text, room) {
    const key  = String(username || '').toLowerCase().trim();
    const rm   = String(room || '').trim();
    if (!key || !text) return;
    const a = this._analyzeMsg(text);
    this._updateUser(key, a, text);
    if (rm) this._updateRoom(rm, key, a);
  }

  // ── Per-message analysis (pure, synchronous) ────────────────────────────────

  _analyzeMsg(text) {
    const t     = text.trim();
    const lower = t.toLowerCase();
    const sentiment = this._sentiment(t, lower);
    const emotions  = this._emotions(lower);
    const intent    = this._intent(t, lower);
    const risk      = this._risk(t, lower, intent, emotions);
    return { sentiment, emotions, intent, dims: this._dimensions(t), authenticity: this._authenticity(t, lower), risk, complexity: this._complexity(t), hostile: HOSTILE_RE.test(t) };
  }

  _sentiment(text, lower) {
    const words = lower.split(/\W+/).filter(Boolean);
    let raw = 0;
    for (const w of words) {
      if (POS_WORDS.has(w)) raw++;
      if (NEG_WORDS.has(w)) raw--;
    }
    const capsRatio = (text.match(/[A-Z]/g) || []).length / Math.max(text.length, 1);
    if (capsRatio > 0.45 && text.length > 5) raw = raw * 1.35;
    const excl = (text.match(/!/g) || []).length;
    if (raw > 0 && excl > 1) raw += 0.5;
    if (raw < 0 && excl > 1) raw -= 0.5;
    const norm = Math.max(-1, Math.min(1, raw / 4));
    return { score: Math.round(norm * 100) / 100, label: norm > 0.1 ? 'positive' : norm < -0.1 ? 'negative' : 'neutral' };
  }

  _emotions(lower) {
    const out = { joy: 0, sadness: 0, anger: 0, fear: 0, love: 0, disgust: 0 };
    for (const [emo, re] of Object.entries(EMOTION_RE)) {
      if (re.test(lower)) out[emo] = 1;
    }
    return out;
  }

  _intent(text, lower) {
    if (HOSTILE_RE.test(text)) return 'hostile';
    if (/\?\s*$/.test(text) || /^(who|what|when|where|why|how|is |are |do |does |did |can |could |would |should |have )/i.test(text)) return 'question';
    if (/\b(please|can you|could you|would you|i need|i want|help me|give me)\b/.test(lower)) return 'request';
    if (/\b(stop|don't|shut up|get out|leave|you should|you need to)\b/.test(lower) && text.length < 80) return 'command';
    if (/\b(hate|sucks|terrible|worst|broken|why is|can't believe|what the|garbage|pathetic|useless)\b/.test(lower)) return 'complaint';
    if (text.length < 38 && /\b(lol|lmao|haha|hehe|xd|sure|ok|yeah|nah|fair|true|nice|fr|damn|oof|yikes|based|kek|rip|welp)\b/.test(lower)) return 'banter';
    return 'casual';
  }

  _dimensions(text) {
    const out = {};
    for (const [d, re] of Object.entries(DIM_RE)) out[d] = re.test(text) ? 1 : 0;
    return out;
  }

  _authenticity(text, lower) {
    let score = 0.5;
    if (/\b(i think|i believe|i feel|in my opinion|honestly|personally|my take|i find|i notice|for me)\b/i.test(text)) score += 0.15;
    if (/\b(actually|genuinely|seriously|real talk|no lie|to be honest|tbh|straight up)\b/.test(lower))              score += 0.10;
    if (text.length > 80)                                                                                              score += 0.05;
    if (/\b(you.?re so|literally the best|amazing person|best thing ever|wow so|incredible|no way that.?s)\b/.test(lower)) score -= 0.15;
    if (/[!]{2,}|[?!]{3,}/.test(text))                                                                                score -= 0.08;
    if (/\b(totally agree|absolutely|100%|exactly right|so true|facts bro|preach|based|no cap)\b/.test(lower))       score -= 0.10;
    score = Math.max(0, Math.min(1, score));
    return { score: Math.round(score * 100) / 100, label: score >= 0.62 ? 'genuine' : score <= 0.38 ? 'performative' : 'mixed' };
  }

  _risk(text, lower, intent, emotions) {
    let score = 0;
    if (intent === 'hostile')         score += 0.45;
    if (THREAT_RE.test(text))         score += 0.35;
    if (DOXX_RE.test(text))           score += 0.55;
    if (emotions.anger && intent === 'complaint') score += 0.15;
    if (intent === 'complaint' && score === 0)    score  = 0.10;
    score = Math.min(1, score);
    const level = score >= 0.7 ? 'critical' : score >= 0.4 ? 'high' : score >= 0.15 ? 'medium' : 'low';
    return { score: Math.round(score * 100) / 100, level };
  }

  _complexity(text) {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    const avgLen = words.reduce((s, w) => s + w.length, 0) / words.length;
    const punct  = (text.match(/[,;:—–]/g) || []).length;
    return Math.round(Math.min(10, (words.length / 6) + (avgLen / 2) + punct * 0.4) * 10) / 10;
  }

  // ── User state ──────────────────────────────────────────────────────────────

  _getUser(key) {
    if (!this._users.has(key)) {
      this._users.set(key, {
        dims:            { logical:0, emotional:0, creative:0, analytical:0, intuitive:0, empathetic:0, philosophical:0, practical:0 },
        sentimentSum:    0,
        emotionSums:     { joy:0, sadness:0, anger:0, fear:0, love:0, disgust:0 },
        intents:         { question:0, request:0, command:0, complaint:0, hostile:0, banter:0, casual:0 },
        riskSum:         0,
        complexitySum:   0,
        authSum:         0,
        spamCount:       0,
        repetitiveCount: 0,
        msgCount:        0,
        lastMsgTs:       null,
        _recentTimes:    [],   // timestamps for spam detection
        _recentTexts:    [],   // last 5 normalized texts for repetition detection
      });
    }
    return this._users.get(key);
  }

  _updateUser(key, a, text) {
    const s   = this._getUser(key);
    const now = Date.now();

    // Spam: >6 messages in 60 seconds
    const windowStart = now - 60_000;
    s._recentTimes = s._recentTimes.filter(t => t > windowStart);
    if (s._recentTimes.length >= 6) s.spamCount++;
    s._recentTimes.push(now);

    // Repetition: same normalized text seen in last 5 messages
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (s._recentTexts.includes(norm)) s.repetitiveCount++;
    s._recentTexts.push(norm);
    if (s._recentTexts.length > 5) s._recentTexts.shift();

    s.msgCount++;
    s.sentimentSum  += a.sentiment.score;
    s.riskSum       += a.risk.score;
    s.complexitySum += a.complexity;
    s.authSum       += a.authenticity.score;
    for (const [d, v] of Object.entries(a.dims))       s.dims[d]          += v;
    for (const [e, v] of Object.entries(a.emotions))   s.emotionSums[e]   += v;
    s.intents[a.intent] = (s.intents[a.intent] || 0) + 1;
    s.lastMsgTs = now;
  }

  // ── Social status derivation ────────────────────────────────────────────────

  _deriveStatus(s, userRoomCount, totalRoomMsgs) {
    if (!s.msgCount) return 'unknown';
    const share    = totalRoomMsgs > 0 ? (userRoomCount || s.msgCount) / totalRoomMsgs : 0;
    const qShare   = (s.intents.question  || 0) / s.msgCount;
    const hShare   = (s.intents.hostile   || 0) / s.msgCount;
    const bShare   = (s.intents.banter    || 0) / s.msgCount;
    if (hShare > 0.2)                         return 'outcast';
    if (share > 0.25 && qShare < 0.3)         return 'leader';
    if (share < 0.05 && s.msgCount < 5)       return 'loner';
    if (qShare > 0.35 || bShare > 0.55)       return 'follower';
    return 'participant';
  }

  _dominantDim(dims) {
    const sorted = Object.entries(dims).sort(([,a],[,b]) => b - a);
    return sorted[0]?.[1] > 0 ? sorted[0][0] : null;
  }

  // ── Room state ──────────────────────────────────────────────────────────────

  _getRoom(room) {
    if (!this._rooms.has(room)) {
      this._rooms.set(room, {
        activity:  new Map(),  // user → msg count
        recent:    [],         // [{user, intent, sentScore, ts}]
        conflicts: new Map(),  // user → {intensity, ts}
        flow:      { phase: 'casual', momentum: 0.5, health: 0.8, balance: 0.5 },
      });
    }
    return this._rooms.get(room);
  }

  _updateRoom(room, user, a) {
    const rs  = this._getRoom(room);
    const now = Date.now();

    rs.activity.set(user, (rs.activity.get(user) || 0) + 1);

    rs.recent.push({ user, intent: a.intent, sentScore: a.sentiment.score, ts: now });
    if (rs.recent.length > this._maxRoomHistory) rs.recent.shift();

    // Conflict: hostile message → track; cool down after 10 min of good behavior
    if (a.hostile || a.risk.level === 'high' || a.risk.level === 'critical') {
      rs.conflicts.set(user, { intensity: a.risk.score, ts: now });
    } else if (rs.conflicts.has(user) && now - rs.conflicts.get(user).ts > 10 * 60_000) {
      rs.conflicts.delete(user);
    }
    // Prune stale conflicts
    for (const [k, v] of rs.conflicts) {
      if (now - v.ts > 10 * 60_000) rs.conflicts.delete(k);
    }

    // Bound room user count — evict least active
    if (rs.activity.size > this._maxRoomUsers) {
      const sorted = [...rs.activity.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < rs.activity.size - this._maxRoomUsers; i++) rs.activity.delete(sorted[i][0]);
    }

    this._updateFlow(rs);
  }

  _updateFlow(rs) {
    const last = rs.recent.slice(-12);
    if (!last.length) return;

    const counts = { question:0, banter:0, casual:0, hostile:0, complaint:0, request:0, command:0 };
    for (const m of last) counts[m.intent] = (counts[m.intent] || 0) + 1;

    let phase = 'casual';
    if (counts.hostile + counts.complaint > 4) phase = 'conflict';
    else if (counts.question > 4)              phase = 'info_exchange';
    else if (counts.banter > 5)                phase = 'banter';
    else if (counts.request + counts.command > 3) phase = 'task';
    else if (rs.recent.length < 6)             phase = 'opening';

    const fiveMinsAgo  = Date.now() - 5 * 60_000;
    const recentBurst  = rs.recent.filter(m => m.ts > fiveMinsAgo).length;
    const momentum     = Math.round(Math.min(1, recentBurst / 20) * 100) / 100;

    const avgSent = last.reduce((s, m) => s + m.sentScore, 0) / last.length;
    const health  = Math.round(Math.max(0, Math.min(1, (avgSent + 1) / 2)) * 100) / 100;

    const activeUsers = new Set(last.map(m => m.user)).size;
    const balance     = Math.round(Math.min(1, activeUsers / 4) * 100) / 100;

    rs.flow = { phase, momentum, health, balance };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Full analysis snapshot for a user.
   * Returns null if fewer than 3 messages have been observed.
   */
  getAnalysis(username) {
    const key = String(username || '').toLowerCase().trim();
    const s   = this._users.get(key);
    if (!s || s.msgCount < 3) return null;

    const n           = s.msgCount;
    const avgSent     = s.sentimentSum  / n;
    const avgRisk     = s.riskSum       / n;
    const avgAuth     = s.authSum       / n;
    const avgComp     = s.complexitySum / n;

    const emotions = {};
    for (const [e, v] of Object.entries(s.emotionSums)) {
      emotions[e] = Math.round((v / n) * 100) / 100;
    }
    const domEmo = Object.entries(emotions).sort(([,a],[,b]) => b - a)[0];

    const topIntent = Object.entries(s.intents).sort(([,a],[,b]) => b - a)[0]?.[0] || 'casual';

    return {
      analyzed:          n,
      sentimentScore:    Math.round(avgSent * 100) / 100,
      sentimentLabel:    avgSent > 0.08 ? 'positive' : avgSent < -0.08 ? 'negative' : 'neutral',
      emotions,
      dominantEmotion:   (domEmo?.[1] > 0.1) ? domEmo[0] : null,
      dimensions:        { ...s.dims },
      dominantDim:       this._dominantDim(s.dims),
      secondaryDim:      this._secondaryDim(s.dims),
      intents:           { ...s.intents },
      topIntent,
      authenticity:      avgAuth >= 0.62 ? 'genuine' : avgAuth <= 0.38 ? 'performative' : 'mixed',
      authenticityScore: Math.round(avgAuth * 100) / 100,
      riskScore:         Math.round(avgRisk * 100) / 100,
      riskLevel:         avgRisk >= 0.4 ? 'high' : avgRisk >= 0.15 ? 'medium' : 'low',
      complexityAvg:     Math.round(avgComp * 10) / 10,
      spamCount:         s.spamCount,
      repetitiveCount:   s.repetitiveCount,
      lastAnalyzed:      s.lastMsgTs,
    };
  }

  _secondaryDim(dims) {
    const sorted = Object.entries(dims).filter(([,v]) => v > 0).sort(([,a],[,b]) => b - a);
    return sorted[1]?.[0] || null;
  }

  /**
   * Social status of a user within a specific room.
   * Returns: leader | follower | loner | outcast | participant | unknown
   */
  getSocialStatus(username, room) {
    const key  = String(username || '').toLowerCase().trim();
    const s    = this._users.get(key);
    const rs   = room ? this._rooms.get(String(room)) : null;
    if (!s || !s.msgCount) return 'unknown';
    let totalRoomMsgs = 0;
    if (rs) for (const v of rs.activity.values()) totalRoomMsgs += v;
    return this._deriveStatus(s, rs?.activity.get(key) || 0, totalRoomMsgs);
  }

  /**
   * Room-level conversation snapshot.
   */
  getRoomSnapshot(room) {
    const rs = this._rooms.get(String(room));
    if (!rs) return null;
    return {
      flow:            { ...rs.flow },
      activeUsers:     rs.activity.size,
      activeConflicts: rs.conflicts.size,
      topContributors: [...rs.activity.entries()].sort(([,a],[,b]) => b - a).slice(0, 5).map(([u]) => u),
    };
  }

  /**
   * Compact one-line context string for AI prompt injection.
   * Returns null if not enough data yet.
   */
  getContextLine(username, room) {
    const a = this.getAnalysis(username);
    if (!a) return null;

    const status = this.getSocialStatus(username, room);
    const parts  = [];

    const dimLabel = [a.dominantDim, a.secondaryDim].filter(Boolean).join('/');
    if (dimLabel) parts.push(dimLabel);
    if (a.authenticity !== 'mixed')  parts.push(a.authenticity);
    if (status && status !== 'participant') parts.push(status);
    if (a.riskLevel !== 'low')       parts.push(`⚠risk=${a.riskLevel}`);
    if (a.dominantEmotion)           parts.push(`emo=${a.dominantEmotion}`);
    if (a.topIntent !== 'casual' && a.topIntent !== 'banter') parts.push(`tends=${a.topIntent}`);

    if (!parts.length) return null;
    return `PSYCH[${username}]: ${parts.join(' | ')} | vibe=${a.sentimentLabel} | n=${a.analyzed}`;
  }

  /**
   * All users observed in a room, sorted by risk desc then msg count desc.
   * @param {string} [room] — if provided, adds social status relative to that room
   * @returns {Array<Object>}
   */
  getAllAnalyses(room) {
    const out = [];
    for (const key of this._users.keys()) {
      const a = this.getAnalysis(key);
      if (!a) continue;
      out.push({
        username:       key,
        analyzed:       a.analyzed,
        sentimentLabel: a.sentimentLabel,
        sentimentScore: a.sentimentScore,
        dominantDim:    a.dominantDim,
        secondaryDim:   a.secondaryDim,
        dominantEmotion:a.dominantEmotion,
        authenticity:   a.authenticity,
        riskLevel:      a.riskLevel,
        riskScore:      a.riskScore,
        topIntent:      a.topIntent,
        complexityAvg:  a.complexityAvg,
        spamCount:      a.spamCount,
        repetitiveCount:a.repetitiveCount,
        socialStatus:   room ? this.getSocialStatus(key, room) : null,
        lastAnalyzed:   a.lastAnalyzed,
      });
    }
    const RISK_ORD = { critical: 4, high: 3, medium: 2, low: 1 };
    out.sort((a, b) => {
      const rd = (RISK_ORD[b.riskLevel] || 0) - (RISK_ORD[a.riskLevel] || 0);
      return rd !== 0 ? rd : b.analyzed - a.analyzed;
    });
    return out;
  }

  /**
   * Full formatted block for .psychprofile AI prompt injection.
   */
  formatForPrompt(username, room) {
    const a = this.getAnalysis(username);
    if (!a) return null;
    const status = this.getSocialStatus(username, room);
    const topDims = Object.entries(a.dimensions)
      .filter(([,v]) => v > 0).sort(([,a],[,b]) => b - a).slice(0, 4)
      .map(([k, v]) => `${k}:${v}`).join(', ');
    const topEmotions = Object.entries(a.emotions)
      .filter(([,v]) => v > 0.05).sort(([,a],[,b]) => b - a)
      .map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`).join(', ');
    const intentStr = Object.entries(a.intents)
      .filter(([,v]) => v > 0).sort(([,a],[,b]) => b - a)
      .map(([k, v]) => `${k}:${v}`).join(', ');
    const lines = [
      `REAP ANALYSIS (${a.analyzed} msgs, last analyzed: ${a.lastAnalyzed ? new Date(a.lastAnalyzed).toISOString() : 'unknown'}):`,
      `sentiment: ${a.sentimentLabel} (${a.sentimentScore}) | authenticity: ${a.authenticity} (${a.authenticityScore}) | social: ${status}`,
      `risk: ${a.riskLevel} (${a.riskScore}) | complexity avg: ${a.complexityAvg}`,
      topDims     ? `personality dims: ${topDims}`   : null,
      topEmotions ? `emotional profile: ${topEmotions}` : null,
      intentStr   ? `intent distribution: ${intentStr}` : null,
      a.spamCount > 0 || a.repetitiveCount > 0 ? `behavioral flags: spam_bursts=${a.spamCount} repetitive=${a.repetitiveCount}` : null,
    ];
    return lines.filter(Boolean).join('\n');
  }
}

module.exports = PsychAnalyzer;
