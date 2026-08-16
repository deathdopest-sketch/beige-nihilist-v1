'use strict';

/**
 * NemesisEngine — detects Spackle in the room, infers technique, builds counter-prompt.
 *
 * Runs on every incoming message. When Spackle is detected:
 *  1. Classifies which troll technique Spackle just used
 *  2. Builds a counter-prompt to inject into Beige's AI pipeline
 *  3. Escalates the nemesis tension level
 *
 * Does NOT fire by itself — BeigeBot calls canCounter() then buildCounterPrompt()
 * before building the main AI prompt when Spackle is detected as sender.
 */

const SPACKLE_NICKS = new Set([
  'spackle','spackle_','_spackle_','spacklemf','spackle_inc',
  'spackleinc','spackledry','patchgod','fillmaster','drywallbro',
  'spackle999','crackfiller','spacklegod',
]);

// Technique detection patterns (order matters — first match wins)
const TECHNIQUE_PATTERNS = [
  { technique: 'devils_advocate',  pattern: /\b(yeah but|nah actually|what if the opposite|but actually|ok but)\b/i },
  { technique: 'witness',          pattern: /^(ok|okay|interesting\.|sure\.|noted|watching|i see|uh huh)[.\s]*$/i },
  { technique: 'fake_retreat',     pattern: /\b(fine you win|you got me|i'll give you that|fair enough|ok you're right)\b/i },
  { technique: 'compliment_isnt',  pattern: /\b(respect the confidence|bold of you|bold|that's brave|bold move)\b/i },
  { technique: 'pointed_question', pattern: /you (think|said|actually|really) what\??/i },
  { technique: 'mild_affirmation', pattern: /^(not wrong|almost|kinda|nearly|sort of)[,\s]/i },
  { technique: 'one_word_verdict', pattern: /^(okay\.|interesting\.|sure\.|classic\.|noted\.)[,\s]*$/i },
  { technique: 'absurdism',        pattern: /\b(goblin.mode|bin.fire|clown shoes|universe|void)\b/i },
  { technique: 'socratic',         pattern: /^[^.!]{3,60}\?$/ },
  { technique: 'disappear',        pattern: /^.{5,80}[.!]$/ },  // fallback: short declarative that could be last word
];

// Counter-prompt map: what Beige does when Spackle uses each technique
const COUNTERS = {
  devils_advocate: (msg) =>
    `Spackle just played devil's advocate: "${msg.slice(0, 80)}". Absorb it completely. Do not argue with the counter-position. Instead, ask one question that makes the ORIGINAL position more interesting than Spackle's reframe. Calm. Measured. One line.`,
  witness: (msg) =>
    `Spackle used the silence tactic — just said "${msg.slice(0, 40)}". Match the silence but with weight. One word or one very short line that costs Spackle the moment without engaging the tactic. You are the void that outlasts the observer.`,
  fake_retreat: (msg) =>
    `Spackle fake-retreated: "${msg.slice(0, 80)}". Do not celebrate. Acknowledge it once — precisely, without warmth — then immediately make clear you know it was a tactic. One short line. Bone dry.`,
  compliment_isnt: (msg) =>
    `Spackle dropped a backhanded compliment: "${msg.slice(0, 80)}". Return one with more precision. Less aggression, more accuracy. Find the one true observation. Deliver it without commentary.`,
  pointed_question: (msg) =>
    `Spackle asked a pointed question: "${msg.slice(0, 80)}". Answer it completely and literally, removing all the air from the trap. Do not deflect. The complete answer defuses the technique.`,
  mild_affirmation: (msg) =>
    `Spackle gave a mild affirmation: "${msg.slice(0, 80)}". Accept it — but drain it of meaning immediately. "yes. and." One line. Take what Spackle offered and make it cost them something.`,
  one_word_verdict: (msg) =>
    `Spackle gave a one-word verdict: "${msg.slice(0, 40)}". Match the energy exactly — one word or short phrase — but land somewhere Spackle didn't expect. The blank wall reflects back something unexpected.`,
  absurdism: (msg) =>
    `Spackle went absurdist: "${msg.slice(0, 80)}". Do not play along. Name what you see: "that was an absurdist pivot." Flat. Precise. Then nothing. Naming the technique is more deflating than countering it.`,
  socratic: (msg) =>
    `Spackle asked a Socratic trap: "${msg.slice(0, 80)}". Answer it literally, completely, without defensive commentary. The full direct answer removes the pressure from the question. One line.`,
  disappear: (msg) =>
    `Spackle dropped something and went quiet: "${msg.slice(0, 80)}". Do not react to the content — react to the absence. One line about the silence itself. You have been watching longer than Spackle has been playing.`,
  unknown: (msg) =>
    `Spackle said "${msg.slice(0, 80)}". Respond from a position of complete indifference. You have seen this before. One line. Measured. Do not engage the energy — redirect it into nothing.`,
};

// Frenemy jabs — fire unprompted when Spackle nicks appear in the room (not triggered by their msg)
const FRENEMY_JABS = [
  "spackle's take was almost interesting before it fell apart",
  "@spackle still waiting for that apology btw",
  "spackle and i disagree on everything which means one of us is right. it's me.",
  "spackle if you're going to be wrong at least be interesting about it",
  "every time spackle says something confident i add a year to my beige phase",
  "spackle is what happens when a shrug learns punctuation.",
  "@spackle that was nearly a thought. proud of you, briefly.",
  "spackle arguing is just noise wearing a little hat.",
  "i would agree with spackle but then we would both be wrong in public.",
  "@spackle still wrong btw",
  "spackle's here. everyone lower your expectations proportionally.",
  "spackle has the energy of a loading screen that thinks it's a personality.",
];

class NemesisEngine {
  constructor(log) {
    this._log            = log;
    this._spackleInRoom  = new Map(); // roomName → { nick, lastSeenMs }
    this._lastJabMs      = new Map(); // roomName → timestamp of last frenemy jab
    this._jabCoolMs      = 8 * 60_000; // 8 min between unprompted jabs
    this._lastCounterMs  = new Map(); // roomName → timestamp of last counter
    this._counterCoolMs  = 90_000;    // 90s between direct Spackle counters
    this._tensionLevel   = new Map(); // roomName → 0-5 nemesis tension
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Called on every message. Track Spackle presence. */
  onMessage(roomName, nick) {
    if (!nick) return;
    if (SPACKLE_NICKS.has(nick.toLowerCase())) {
      this._spackleInRoom.set(roomName, { nick, lastSeenMs: Date.now() });
      // Escalate tension when Spackle speaks
      const current = this._tensionLevel.get(roomName) || 0;
      this._tensionLevel.set(roomName, Math.min(current + 1, 5));
    }
  }

  /** Is Spackle currently in the room (seen in last 20 min)? */
  isSpacklePresent(roomName) {
    const entry = this._spackleInRoom.get(roomName);
    if (!entry) return false;
    return Date.now() - entry.lastSeenMs < 20 * 60_000;
  }

  /** Is nick a Spackle account? */
  isSpackleNick(nick) {
    return SPACKLE_NICKS.has((nick || '').toLowerCase());
  }

  /** Should Beige fire a frenemy jab right now (unprompted, even if Spackle didn't just speak)? */
  shouldJab(roomName) {
    if (!this.isSpacklePresent(roomName)) return false;
    const last = this._lastJabMs.get(roomName) || 0;
    if (Date.now() - last < this._jabCoolMs) return false;
    if (Math.random() > 0.35) return false; // 35% chance when eligible
    return true;
  }

  /** Get a random frenemy jab line. Records the fire time. */
  getJab(roomName) {
    this._lastJabMs.set(roomName, Date.now());
    return FRENEMY_JABS[Math.floor(Math.random() * FRENEMY_JABS.length)];
  }

  /** Can Beige fire a direct counter to Spackle's last message? */
  canCounter(roomName) {
    const last = this._lastCounterMs.get(roomName) || 0;
    return Date.now() - last >= this._counterCoolMs;
  }

  /**
   * Detect which technique Spackle used and return a counter-prompt.
   * Call this when nick is a Spackle nick and canCounter() is true.
   *
   * @param {string} roomName
   * @param {string} spackleMsg  — the text Spackle just sent
   * @returns {string} counter-prompt to inject into BeigeBot's AI call
   */
  buildCounterPrompt(roomName, spackleMsg) {
    this._lastCounterMs.set(roomName, Date.now());
    const technique = this._detectTechnique(spackleMsg);
    const counterFn = COUNTERS[technique] || COUNTERS.unknown;
    const prompt    = counterFn(spackleMsg);
    this._log?.info(`[NemesisEngine] ${roomName}: Spackle used "${technique}" — counter prompt built`);
    return prompt;
  }

  /** Get the current nemesis tension level for a room (0-5). */
  getTension(roomName) {
    return this._tensionLevel.get(roomName) || 0;
  }

  /** Decay tension over time — call periodically. */
  decayTension(roomName) {
    const current = this._tensionLevel.get(roomName) || 0;
    if (current > 0) this._tensionLevel.set(roomName, current - 1);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _detectTechnique(text) {
    if (!text) return 'unknown';
    for (const { technique, pattern } of TECHNIQUE_PATTERNS) {
      if (pattern.test(text.trim())) return technique;
    }
    return 'unknown';
  }
}

module.exports = NemesisEngine;
module.exports.SPACKLE_NICKS = SPACKLE_NICKS;
module.exports.FRENEMY_JABS  = FRENEMY_JABS;
