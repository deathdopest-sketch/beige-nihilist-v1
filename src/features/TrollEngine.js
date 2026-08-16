'use strict';

/**
 * TrollEngine — strategic troll intelligence for Beige_nihilist.
 *
 * Responsibilities:
 *   - TrollScorer:       rates each incoming message for troll potential (0–10)
 *   - TargetSelector:    identifies the most trollable person in the room right now
 *   - TechniquePicker:   selects a troll technique from Beige's library based on context
 *   - EscalationTracker: per-user escalation level with auto-cooldown
 *
 * Beige's techniques are methodical and void-focused — the opposite of Spackle's chaos.
 * Used by BeigeBot to decide WHEN and HOW to troll.
 */

const TECHNIQUE_LIBRARY = {
  void: {
    description: 'Absorb chaos without reacting — let it die in the room',
    promptHint:  'The room has energy. Do not feed it. One flat line or nothing. If you speak, acknowledge without engaging. "noted." / "that happened." / "sure." — delivered with zero energy given.',
    contextBoost: ['chaos', 'heated', 'loud'],
  },
  deconstruct: {
    description: 'Take apart the premise of what was said, stone by stone',
    promptHint:  'Take the premise of their statement and expose the assumption underneath it. "that assumes X" / "that only works if you accept Y, which..." One line. Not hostile — surgical.',
    contextBoost: ['strong_claim', 'opinion', 'technical'],
  },
  socratic: {
    description: 'Questions that expose the logic gap — slower than Spackle\'s version',
    promptHint:  'Ask one question that makes the gap in their logic visible. "by what definition of good, exactly" / "and that means what for..." Slower and more precise than a quick jab. Never explain why you asked.',
    contextBoost: ['strong_claim', 'opinion', 'argument'],
  },
  agreed_destruction: {
    description: 'Agree completely, then follow the logic to its absurd conclusion',
    promptHint:  'Agree with what they said completely and sincerely. Then take that agreement one logical step further — to where it stops making sense. Never mock. Just agree harder.',
    contextBoost: ['consensus', 'excited', 'heated'],
  },
  long_memory: {
    description: 'Reference something from 20+ minutes ago as if it is still relevant',
    promptHint:  'Bring back something from earlier in the conversation — something nobody remembered — as if it is the most relevant thing right now. Matter-of-fact. Never signal that you have been holding it.',
    contextBoost: ['returning_user', 'prior_drama', 'familiar'],
  },
  pattern_call: {
    description: 'Name the pattern someone is running — "you do this every time"',
    promptHint:  'Name the behaviour pattern you have observed. Not accusatory — observational. "you do this every time X happens." / "this is the part where you..." Flat. Without drama.',
    contextBoost: ['repeated_behaviour', 'escalated', 'argument'],
  },
  deflation: {
    description: 'One sentence that removes all the energy from a moment',
    promptHint:  'The moment has energy — excitement, anger, triumph, humour. One line that gently removes all of it. "nothing you said was wrong per se. it was just... beige." / "yes. and." Not cruel. Just accurate enough to deflate.',
    contextBoost: ['excited', 'heated', 'dramatic'],
  },
  disappear: {
    description: 'Say something final, then go completely silent',
    promptHint:  'This is your last message for a long time. Say something precise and complete — not inflammatory, just final. Then nothing. The silence is the second half of the message. Make it land without needing a follow-up.',
    contextBoost: ['escalated', 'attention_seeking', 'drama'],
  },
};

// ── Scoring heuristics ────────────────────────────────────────────────────────

const CONTROVERSY_WORDS = new Set([
  // Politics/society
  'politics','vote','trump','labor','liberal','guns','abortion','vax','covid','religion',
  'god','jesus','islam','woke','trans','gender','race','racist','sexist','feminism',
  'crypto','bitcoin','nft','ai','chatgpt','tiktok','twitter','cancel','privilege',
  // Meatspace staples — money/status/class
  'money','rich','poor','broke','section 8','welfare','food stamps','car','house','rent',
  'paid','salary','income','job','work','employed','unemployed','homeless','beg','afford',
  // Personal attacks / insults (high troll potential)
  'liar','lies','lying','fake','clown','stupid','idiot','dumb','moron','loser','cuck',
  'pussy','bitch','simp','incel','creep','perv','desperate','pathetic','cringe',
  // Sex / relationships (meatspace loves this)
  'sex','dick','ass','tits','naked','cam','flirt','horny','simping','thirsty',
  'relationship','wife','husband','girlfriend','boyfriend','dating','baby mama',
  // Bragging / status flex
  'flex','clout','famous','viral','followers','subscribers','views','brand','hustle',
  '6 figures','6 digits','six figures','high six','property','sold','profit','invest',
]);

const EMOTIONAL_MARKERS = new Set([
  '!!!','??','wtf','omg','literally','actually','honestly','seriously','no way','cant believe',
  'you people','everyone knows','obvious','fact','truth','wake up','sheeple','clown',
  // Direct aggression patterns (rocket fuel for trolling)
  'shut up','stfu','shut the fuck','go fuck','fuck you','you said','u said','prove it',
  'i bet','you think','you act like','you always','you never','ur a','you are a',
]);

class TrollScorer {
  /**
   * Score a message 0–10 for troll potential.
   * Higher = more trollable.
   */
  score(msg, userProfile, roomContext) {
    if (!msg || msg.length < 3) return 0;
    let score = 0;
    const t = msg.toLowerCase();

    // Length: very short or very long are interesting
    if (msg.length < 20)  score += 1;
    if (msg.length > 120) score += 1.5;

    // Contains controversy keywords
    const contrWords = [...CONTROVERSY_WORDS].filter(w => t.includes(w));
    score += Math.min(contrWords.length * 1.5, 4);

    // Emotional markers
    const emoWords = [...EMOTIONAL_MARKERS].filter(w => t.includes(w));
    score += Math.min(emoWords.length, 3);

    // Ends with ? — loves a question
    if (/\?\s*$/.test(msg.trim())) score += 1;

    // Strong claim pattern ("everyone knows", "it's obvious", "always/never")
    if (/\b(everyone knows|obviously|clearly|always|never|only idiots|you can't deny)\b/i.test(t)) score += 2;

    // Direct personal attack at someone in the room (highest troll fuel)
    if (/\b(ur a|you are a|you're a|you act like|you always|you never|i bet you|prove it|shut up|stfu|go fuck|fuck you)\b/i.test(t)) score += 3;

    // Bragging about money/status (invite contradiction)
    if (/\b(\d{3,}k|six figures|6 figures|paid off|sold for|bought|own|owned)\b/i.test(t)) score += 2;

    // Lying/credibility challenge in progress
    if (/\b(liar|lying|lies|fake|cap|no cap|bs|bullshit|i don't believe)\b/i.test(t)) score += 2.5;

    // User profile boosters
    if (userProfile) {
      if (userProfile.times_called_out > 0)   score += 0.5; // been called out before — more reactive
      if (userProfile.troll_score > 0.5)       score += userProfile.troll_score * 2;
      if (userProfile.relationship === 'target') score += 1;
    }

    // Room context: ongoing argument?
    if (roomContext?.activeArgument) score += 2;
    if (roomContext?.recentDrama)     score += 1;

    return Math.min(Math.round(score * 10) / 10, 10);
  }

  /**
   * Classify what kind of message this is.
   * Used by TechniquePicker.
   */
  classify(msg) {
    const t = msg.toLowerCase();
    const tags = new Set();

    if (/\?\s*$/.test(msg.trim()))                              tags.add('question');
    if (/\b(always|never|everyone|nobody|obviously)\b/i.test(t)) tags.add('strong_claim');
    if (CONTROVERSY_WORDS.has(t) || [...CONTROVERSY_WORDS].some(w => t.includes(w))) tags.add('opinion');
    if (/[!?!?]{2,}|wtf|omg|no way/i.test(t))                 tags.add('heated');
    if (msg.length < 25)                                        tags.add('casual');
    if (msg.length > 100)                                       tags.add('technical');
    if (/\b(lol|lmao|haha|😂|💀|🤣)\b/i.test(t))              tags.add('boring');

    return [...tags];
  }
}

// ── Target selection ──────────────────────────────────────────────────────────

class TargetSelector {
  constructor(trollLedger) {
    this._ledger = trollLedger;
  }

  /**
   * From a list of recent messages, pick the best target.
   * Returns { nick, reason } or null.
   */
  selectTarget(recentMessages, currentNick) {
    if (!recentMessages?.length) return null;

    const candidates = {};
    for (const m of recentMessages) {
      if (!m.nick || m.nick === currentNick) continue;
      if (!candidates[m.nick]) {
        candidates[m.nick] = {
          nick: m.nick,
          msgCount: 0,
          totalLength: 0,
          hasQuestion: false,
          hasOpinion: false,
        };
      }
      const c = candidates[m.nick];
      c.msgCount++;
      c.totalLength += (m.text || '').length;
      if (/\?\s*$/.test((m.text || '').trim())) c.hasQuestion = true;
      if (/\b(i think|i believe|obviously|clearly|everyone knows)\b/i.test(m.text || '')) c.hasOpinion = true;
    }

    let best = null, bestScore = -1;
    for (const nick of Object.keys(candidates)) {
      const c = candidates[nick];
      const profile = this._ledger?.getProfile(nick);
      let score = c.msgCount * 0.5 + (c.totalLength / 200);
      if (c.hasQuestion) score += 2;
      if (c.hasOpinion)  score += 3;
      if (profile?.relationship === 'target')  score += 2;
      if (profile?.relationship === 'immune')  score -= 10;
      if (profile?.relationship === 'protected') score = -99;
      if (score > bestScore) { bestScore = score; best = c; }
    }

    if (!best || bestScore < 0) return null;
    return { nick: best.nick, reason: best.hasOpinion ? 'strong_opinion' : 'active' };
  }
}

// ── Technique picking ─────────────────────────────────────────────────────────

class TechniquePicker {
  /**
   * Pick a technique given the message tags, user escalation level, and available techniques.
   * Returns a technique key from TROLL_CONFIG.techniques.
   */
  pick(tags, escalationLevel, availableTechniques, lastTechniqueUsed) {
    const tagSet = new Set(tags);

    // Score each technique
    const scores = availableTechniques.map(key => {
      const def = TECHNIQUE_LIBRARY[key];
      if (!def) return { key, score: 0 };
      let score = 1;

      // Boost if context matches
      for (const boost of (def.contextBoost || [])) {
        if (tagSet.has(boost)) score += 2;
      }

      // Avoid repeating last technique
      if (key === lastTechniqueUsed) score -= 3;

      // Escalation gates
      if (key === 'pivot' && escalationLevel < 2)    score -= 2;  // too early
      if (key === 'disappear' && escalationLevel < 3) score -= 2; // need escalation first
      if (key === 'long_game' && escalationLevel > 4) score -= 1; // too late for subtlety
      if (key === 'witness' && escalationLevel >= 3)  score += 2; // silent is terrifying at escalation

      // Jitter so the same technique doesn't dominate
      score += Math.random() * 1.5;

      return { key, score };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores[0]?.key || availableTechniques[0];
  }

  /** Get the AI prompt hint for a technique. */
  getPromptHint(techniqueKey) {
    return TECHNIQUE_LIBRARY[techniqueKey]?.promptHint || '';
  }
}

// ── Escalation tracking ───────────────────────────────────────────────────────

class EscalationTracker {
  constructor(maxLevel = 5, cooldownMs = 20 * 60_000) {
    this._max        = maxLevel;
    this._cooldownMs = cooldownMs;
    this._levels     = new Map(); // nick.toLowerCase() → { level, lastEscalatedAt }
  }

  getLevel(nick) {
    const entry = this._levels.get(nick.toLowerCase());
    if (!entry) return 0;
    // Auto-decay if past cooldown
    const elapsed = Date.now() - entry.lastEscalatedAt;
    if (elapsed > this._cooldownMs) {
      this._levels.delete(nick.toLowerCase());
      return 0;
    }
    return entry.level;
  }

  escalate(nick) {
    const lc = nick.toLowerCase();
    const current = this.getLevel(nick);
    const next = Math.min(current + 1, this._max);
    this._levels.set(lc, { level: next, lastEscalatedAt: Date.now() });
    return next;
  }

  deescalate(nick) {
    const lc = nick.toLowerCase();
    const current = this.getLevel(nick);
    if (current > 0) {
      this._levels.set(lc, { level: current - 1, lastEscalatedAt: Date.now() });
    }
  }

  reset(nick) {
    this._levels.delete(nick.toLowerCase());
  }

  /** Returns true if the troll should hold fire on this user right now. */
  isCoolingDown(nick) {
    const entry = this._levels.get(nick.toLowerCase());
    if (!entry) return false;
    const elapsed = Date.now() - entry.lastEscalatedAt;
    return elapsed < this._cooldownMs && entry.level >= this._max;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

class TrollEngine {
  constructor(trollConfig, trollLedger, log) {  // eslint-disable-line no-unused-vars
    this._config    = trollConfig;
    this._ledger    = trollLedger;
    this._log       = log;
    this.scorer     = new TrollScorer();
    this.targets    = new TargetSelector(trollLedger);
    this.techniques = new TechniquePicker();
    this.escalation = new EscalationTracker(
      trollConfig.maxEscalationLevel,
      trollConfig.escalationCooldownMs,
    );
    this._lastTechnique = new Map(); // roomName → last technique key used
  }

  /**
   * Analyse an incoming message and return a troll decision.
   *
   * Returns:
   *   { shouldTroll: false }
   *   { shouldTroll: true, score, technique, promptHint, target }
   */
  analyse(roomName, nick, text, recentMessages, userProfile, roomContext) {
    if (!this._config.enabled) return { shouldTroll: false };

    // Never troll protected identities
    if (this._ledger?.getProfile(nick)?.relationship === 'protected') return { shouldTroll: false };

    const score     = this.scorer.score(text, userProfile, roomContext);
    const tags      = this.scorer.classify(text);
    const escLevel  = this.escalation.getLevel(nick);
    const lastTech  = this._lastTechnique.get(roomName);
    const technique = this.techniques.pick(
      tags,
      escLevel,
      this._config.techniques,
      lastTech,
    );
    const promptHint = this.techniques.getPromptHint(technique);
    const target = this.targets.selectTarget(recentMessages, this._selfNick);

    // Decide whether to engage
    const shouldTroll = score >= this._config.trollScoreThreshold
      || (score >= 5 && Math.random() < 0.35)
      || (escLevel > 0 && score >= 3);

    if (shouldTroll) {
      this._lastTechnique.set(roomName, technique);
      this.escalation.escalate(nick);
      if (this._ledger) this._ledger.recordEvent(nick, technique, score);
    }

    return { shouldTroll, score, technique, promptHint, target, tags, escLevel };
  }

  setSelfNick(nick) {
    this._selfNick = nick;
  }
}

module.exports = TrollEngine;
module.exports.TECHNIQUE_LIBRARY = TECHNIQUE_LIBRARY;
