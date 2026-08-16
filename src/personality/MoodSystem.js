'use strict';

/**
 * MoodSystem — ZomB's dual-layer mood tracking.
 *
 * Layer 1: Simple mood (chill/hyped/savage/dead inside/actually engaged)
 *   - Shifts every 45-90 min randomly, or reactively on room triggers
 *   - Used for system prompt hints in generateAIResponse
 *
 * Layer 2: ZomB mood (ravenous/philosophical/war mode/bored/territorial)
 *   - Shifts every 30-90 min, or triggered by hostile/deep room content
 *   - Provides `hint` string injected into AI prompt
 */
class MoodSystem {
  constructor() {
    // Layer 1 — simple mood
    this._moodState = {
      mood     : 'chill',
      since    : Date.now(),
      nextShift: Date.now() + (45 + Math.random() * 45) * 60000,
    };

    // Layer 2 — ZomB mood
    this._zombMood     = this._pickZomBMood();
    this._zombMoodShiftAt = Date.now() + (30 + Math.random() * 60) * 60000;
  }

  // ── Layer 1 ───────────────────────────────────────────────────────────────

  get current() {
    const now = Date.now();
    if (now >= this._moodState.nextShift) {
      const moods = ['chill', 'hyped', 'savage', 'dead inside', 'actually engaged'];
      const opts  = moods.filter(m => m !== this._moodState.mood);
      this._moodState.mood      = opts[Math.floor(Math.random() * opts.length)];
      this._moodState.since     = now;
      this._moodState.nextShift = now + (45 + Math.random() * 45) * 60000;
    }
    return this._moodState.mood;
  }

  /** Reactively shift based on room trigger string. */
  reactTo(trigger) {
    const MAP = { funny: 'hyped', quiet: 'dead inside', drama: 'savage', hype: 'actually engaged' };
    const next = MAP[trigger];
    if (next && next !== this._moodState.mood) {
      this._moodState.mood      = next;
      this._moodState.since     = Date.now();
      this._moodState.nextShift = Date.now() + (30 + Math.random() * 30) * 60000;
    }
  }

  /** Prompt hints injected into AI system prompt. */
  get moodHint() {
    const HINTS = {
      'chill'          : 'Current mood: chill. Relaxed, unhurried. Still sharp but not gunning for anyone.',
      'hyped'          : 'Current mood: hyped. High energy, faster responses, more expressive.',
      'savage'         : 'Current mood: savage. Edges are sharper. Roast mode on. Still coherent, just less patient.',
      'dead inside'    : 'Current mood: dead inside. Minimal effort. Dry, terse, barely engaged. Speak only when it\'s worth it.',
      'actually engaged': 'Current mood: actually engaged. Genuinely interested in the room. More questions, more back-and-forth.',
    };
    return HINTS[this.current] || `Current mood: ${this.current}.`;
  }

  // ── Layer 2 (ZomB mood) ───────────────────────────────────────────────────

  get zombMood()  { return this._zombMood; }
  get zombHint()  { return this._zombMood.hint; }

  _pickZomBMood() {
    const MOODS = [
      { name: 'ravenous',      hint: 'hungry for chaos, responses are more aggressive and impulsive. shorter. sharp.' },
      { name: 'philosophical', hint: 'brooding and introspective. occasional dark observations about existence. still savage but thoughtful.' },
      { name: 'war mode',      hint: 'fully activated, zero chill. everything is a battle. terse, combative, ready to go.' },
      { name: 'bored',         hint: 'barely paying attention. dry, minimal effort, sarcastic about everything including yourself.' },
      { name: 'territorial',   hint: 'protective of the room, suspicious of new energy, marking ground. possessive edge to responses.' },
    ];
    return MOODS[Math.floor(Math.random() * MOODS.length)];
  }

  /** Call periodically / on every message to check for time-based shifts. */
  maybeShift() {
    if (Date.now() >= this._zombMoodShiftAt) {
      const old      = this._zombMood.name;
      this._zombMood = this._pickZomBMood();
      this._zombMoodShiftAt = Date.now() + (30 + Math.random() * 60) * 60000;
      if (this._zombMood.name !== old) {
        return { shifted: true, from: old, to: this._zombMood.name };
      }
    }
    return { shifted: false };
  }

  /** React to room content — hostile energy → war mode; deep topics → philosophical. */
  reactToContent(content) {
    const isHostile = /\b(fight|beef|drama|war|kill|hate|attack|ban|rage|pissed|mad|furious)\b/i.test(content);
    const isDeep    = /\b(death|meaning|life|exist|soul|alone|depress|anxiety|real|truth|void)\b/i.test(content);
    if (isHostile && this._zombMood.name !== 'war mode' && Math.random() < 0.15) {
      this._zombMood = { name: 'war mode', hint: 'room energy pushed you here. fully activated, zero chill.' };
      this._zombMoodShiftAt = Date.now() + 20 * 60000;
    } else if (isDeep && this._zombMood.name !== 'philosophical' && Math.random() < 0.12) {
      this._zombMood = { name: 'philosophical', hint: 'deep room energy pulled you here. brooding and introspective.' };
      this._zombMoodShiftAt = Date.now() + 25 * 60000;
    }
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  toJSON() {
    return {
      moodState  : this._moodState,
      zombMood   : this._zombMood,
      zombMoodShiftAt: this._zombMoodShiftAt,
    };
  }

  fromJSON(data) {
    if (!data) return;
    if (data.moodState)  this._moodState     = data.moodState;
    if (data.zombMood)   this._zombMood       = data.zombMood;
    if (data.zombMoodShiftAt) this._zombMoodShiftAt = data.zombMoodShiftAt;
  }
}

module.exports = MoodSystem;
