'use strict';

/**
 * ChaosAgent — quiet-room presence system for Beige_nihilist.
 *
 * Unlike Spackle's chaos injection, Beige doesn't inject chaos — it deflates it.
 * When the room goes quiet, Beige offers a precise observation or Socratic question,
 * not a grenade.
 *
 * Injection types:
 *   deflation       — one sentence that makes noise feel pointless
 *   philosophical   — a question that makes everyone think
 *   past_reference  — reference something that happened earlier
 *   callout         — call out something said 5-20 minutes ago
 */

const CHAOS_LINES = {
  deflation: [
    'nothing you said was wrong per se. it was just... beige.',
    'by what definition of good, exactly.',
    'real question: why.',
    'fascinating. and you\'ve thought about this how much.',
    'that opinion came pre-muted.',
    'i can see the outline of a point if i squint and lower my standards.',
    'almost persuasive, if we agree words mean vibes now.',
    'you have mistaken volume for structure again.',
    'that take arrived already apologising.',
    'a point-shaped object.',
    'still here. not sure what that says about me.',
    'checking in to see if the room has developed consequences yet.',
    'i have arrived and yet here we all still are.',
    'the void etc. anyway.',
    'deeply mid, carry on.',
    'sure, in the same way all things are technically possible.',
    'you brought certainty to a spoon fight.',
  ],
  philosophical: [
    'genuine question: how much of what you believe about yourself is actually true',
    'do you think the people you argue with online actually hear you or are they just waiting to talk',
    'at what point does defending yourself become the thing that proves the other person right',
    'what is the difference between confidence and just not realising you are wrong',
    'do people actually change or do they just get better at managing what they already are',
    'why do people announce they\'re leaving instead of just leaving',
    'how many people in this room are exactly who they say they are. genuinely curious.',
    'is nostalgia just grief wearing a nice outfit',
    'at what point does a preference become a standard you hold others to',
    'serious question: how much of what you believe is yours versus absorbed',
  ],
};

const QUIET_THRESHOLD_MS    = 90_000;
const ACTIVE_WINDOW_MS      = 4 * 60_000;  // 4 min — window for detecting active pairs
const DIVIDE_COOLDOWN_MS    = 6 * 60_000;  // 6 min between divide injections per room

// Templates for observation-during-argument: Beige names what's happening without taking sides.
// {nickA} and {nickB} are interpolated at runtime.
const DIVIDE_A = [
  '{nickA} is making an argument. it has a structure.',
  'the thing {nickA} said has a premise worth examining',
  '{nickA}\'s position has at least one testable assumption',
  'what {nickA} said assumed something. nobody asked what.',
  'i noticed {nickA} said something and everyone moved on',
];
const DIVIDE_B = [
  'and {nickB} is also making an argument. same.',
  '{nickB}\'s counter also has an assumption worth naming',
  'what {nickB} said is not wrong either, in a specific sense',
  '{nickB} is also not entirely off, by certain definitions',
  'and {nickB}\'s angle contains at least one true thing',
];

class ChaosAgent {
  constructor(trollConfig, dramaArchive, log) {
    this._config      = trollConfig;
    this._drama       = dramaArchive;
    this._log         = log;
    this._lastChaosMs  = new Map();  // roomName → last chaos injection timestamp
    this._lastMsgMs    = new Map();  // roomName → last meaningful message timestamp
    this._roomMsgLog   = new Map();  // roomName → last 20 messages for context
    this._lastDivideMs = new Map();  // roomName → last room-divide injection timestamp
  }

  /**
   * Called on every incoming message. Updates room activity tracking.
   */
  onMessage(roomName, nick, text, selfNick) {
    if (!text || nick === selfNick) return;

    this._lastMsgMs.set(roomName, Date.now());

    const log = this._roomMsgLog.get(roomName) || [];
    log.push({ nick, text, ts: Date.now() });
    if (log.length > 20) log.shift();
    this._roomMsgLog.set(roomName, log);
  }

  /**
   * Should ChaosAgent fire for this room right now?
   * Call this periodically (every 60s) or when FreeVoice would otherwise tick.
   *
   * Returns { should: false } or { should: true, type, line }
   */
  shouldFire(roomName) {
    const minInterval = this._config?.minChaosIntervalMs || 12 * 60_000;
    const lastChaos   = this._lastChaosMs.get(roomName) || 0;
    if (Date.now() - lastChaos < minInterval) return { should: false };

    // Room must have seen activity in the last 10 min (skip dead rooms)
    const lastMsg = this._lastMsgMs.get(roomName) || 0;
    if (Date.now() - lastMsg > 10 * 60_000) return { should: false };

    // 60% chance when eligible — fires into active OR quiet rooms
    if (Math.random() > 0.60) return { should: false };

    const result = this._buildChaos(roomName);
    if (result) {
      this._lastChaosMs.set(roomName, Date.now());
      return { should: true, ...result };
    }
    return { should: false };
  }

  _buildChaos(roomName) {
    // First try: reference past drama (most effective)
    const pastDrama = this._drama?.pickForReference(roomName);
    if (pastDrama && Math.random() > 0.5) {
      return {
        type: 'past_reference',
        line: this._buildDramaReference(pastDrama),
      };
    }

    // Callout: reference something from recent messages
    const recentLog = this._roomMsgLog.get(roomName) || [];
    if (recentLog.length >= 3 && Math.random() > 0.4) {
      const candidates = recentLog.filter(m =>
        m.text?.length > 15 &&
        !/^https?:\/\//i.test(m.text) &&
        !m.text.startsWith('.')
      );
      const target = candidates.length
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : null;
      if (target) {
        return {
          type: 'callout',
          line: this._buildCallout(target),
        };
      }
    }

    // Random chaos from library
    const types = Object.keys(CHAOS_LINES);
    const type  = types[Math.floor(Math.random() * types.length)];
    const pool  = CHAOS_LINES[type];
    return {
      type,
      line: pool[Math.floor(Math.random() * pool.length)],
    };
  }

  _buildDramaReference(event) {
    const mins = Math.round((Date.now() - event.ts) / 60_000);
    const ago  = mins < 60 ? `${mins}min ago` : `${Math.round(mins/60)}h ago`;
    const n    = event.nick;
    // Include the actual quote — "nobody addressed what X said 3h ago" lands as nothing
    // without content; the specific text is what makes a callback sting.
    const raw = event.text ? event.text.slice(0, 65).trim() : null;
    const q   = raw ? `"${raw}"` : null;
    const refs = q ? [
      `${n} said ${q} ${ago} and everyone just kept going.`,
      `nobody picked up on ${q} from ${n} ${ago}.`,
      `still on ${n} saying ${q} ${ago}. that was a choice.`,
      `${n} dropped ${q} ${ago} and it just disappeared.`,
      `${ago}, ${n}: ${q}. room moved on like nothing happened.`,
    ] : [
      `still thinking about ${n} from ${ago}.`,
      `that ${n} thing ${ago} was something.`,
      `nobody addressed what ${n} said ${ago}.`,
    ];
    return refs[Math.floor(Math.random() * refs.length)];
  }

  _buildCallout(msg) {
    const n = msg.nick;
    const quotes = [
      `going back to what ${n} said. it had a premise. nobody examined it.`,
      `what ${n} said ${msg.text?.slice(0, 40) ? `("${msg.text.slice(0, 40)}")` : ''} contains at least one assumption that went unexamined.`,
      `${n} said something earlier and the room moved on. i'm still there.`,
      `the thing ${n} said had structure. it's still sitting there.`,
      `hold on, ${n} said something back there and nobody picked it up`,
      `${n} dropped something earlier and everyone just kept going`,
      `wait did anyone else catch what ${n} said`,
    ];
    return quotes[Math.floor(Math.random() * quotes.length)];
  }

  /**
   * Detect two users in active back-and-forth conversation.
   * Returns [nickA, nickB] or null.
   */
  detectActivePairs(roomName) {
    const log = this._roomMsgLog.get(roomName) || [];
    const now = Date.now();
    const recent = log.filter(m => now - m.ts < ACTIVE_WINDOW_MS);
    if (recent.length < 4) return null;

    // Count messages per unique nick
    const counts = {};
    for (const m of recent) {
      counts[m.nick] = (counts[m.nick] || 0) + 1;
    }
    const active = Object.entries(counts)
      .filter(([, c]) => c >= 2)
      .sort(([, a], [, b]) => b - a)
      .map(([n]) => n);

    if (active.length < 2) return null;
    const [nickA, nickB] = [active[0], active[1]];

    // Require interleaved messages — they must be actually responding to each other,
    // not just both active in parallel. Without this the divide fires on unrelated monologues.
    const nicks = recent.map(m => m.nick);
    let aAfterB = false, bAfterA = false;
    for (let i = 1; i < nicks.length; i++) {
      if (nicks[i] === nickA && nicks[i - 1] === nickB) aAfterB = true;
      if (nicks[i] === nickB && nicks[i - 1] === nickA) bAfterA = true;
      if (aAfterB && bAfterA) return [nickA, nickB];
    }
    return null;
  }

  /**
   * Should the room-divide tactic fire right now?
   * Fires during active conversation (opposite of quiet-room chaos).
   * Returns { should: false } or { should: true, lines: [lineForA, lineForB], nickA, nickB }
   */
  shouldFireDivide(roomName) {
    const lastDivide = this._lastDivideMs.get(roomName) || 0;
    if (Date.now() - lastDivide < DIVIDE_COOLDOWN_MS) return { should: false };
    if (Math.random() > 0.30) return { should: false }; // 30% chance when eligible

    const pair = this.detectActivePairs(roomName);
    if (!pair) return { should: false };
    const [nickA, nickB] = pair;

    const lineA = DIVIDE_A[Math.floor(Math.random() * DIVIDE_A.length)].replace('{nickA}', nickA);
    const lineB = DIVIDE_B[Math.floor(Math.random() * DIVIDE_B.length)].replace('{nickB}', nickB);

    this._lastDivideMs.set(roomName, Date.now());
    return { should: true, lines: [lineA, lineB], nickA, nickB };
  }

  /** Manual trigger: force a specific chaos type. */
  forceFire(roomName, type) {
    const pool = CHAOS_LINES[type];
    if (!pool) return null;
    const line = pool[Math.floor(Math.random() * pool.length)];
    this._lastChaosMs.set(roomName, Date.now());
    return { type, line };
  }
}

module.exports = ChaosAgent;
