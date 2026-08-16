'use strict';

/**
 * BeigeBot — main orchestrator for Beige_nihilist v1.
 *
 * Adapted from SpackleBot. Added Beige-specific systems:
 *  - NemesisEngine  — detects Spackle's technique, builds counter-prompt
 *  - NemesisMemory  — persistent nemesis interaction history
 *
 * Run with: node index.js
 */

// ── Crash handler (must be first) ────────────────────────────────────────────
const path = require('path');
const fs   = require('fs');
const http = require('http');
const _crashLogPath = path.join(__dirname, '..', 'beige_crash.log');
function _writeCrashLog(type, err) {
  try {
    const msg  = err?.stack || err?.message || String(err);
    const line = `[${new Date().toISOString()}] [${type}] ${msg}\n`;
    fs.appendFileSync(_crashLogPath, line);
  } catch (_) {}
}
process.on('unhandledRejection', (reason) => {
  console.error('[Beige] Unhandled rejection:', reason);
  _writeCrashLog('unhandledRejection', reason);
  _bot?._emergencySave();
});
process.on('uncaughtException', (err) => {
  console.error('[Beige] Uncaught exception:', err.message, err.stack || '');
  _writeCrashLog('uncaughtException', err);
  _bot?._emergencySave();
  process.exit(1);
});
let _bot = null;

// ── Requires ──────────────────────────────────────────────────────────────────
require('dotenv').config();

const Logger              = require('./utils/Logger');
const StorageManager      = require('./storage/StorageManager');
const IdentitySystem      = require('./identity/IdentitySystem');
const BrowserManager      = require('./browser/BrowserManager');
const WsListener          = require('./browser/WsListener');
const RoomMonitor         = require('./features/RoomMonitor');
const MessageQueue        = require('./messaging/MessageQueue');
const OllamaClient             = require('./ai/OllamaClient');
const ConversationHistory      = require('./ai/ConversationHistory');
const TieredMemoryManager      = require('./ai/TieredMemoryManager');
const VectorMemoryAdapter      = require('./ai/VectorMemoryAdapter');
const OllamaEmbeddingProvider  = require('./ai/OllamaEmbeddingProvider');
const RelationshipStateEngine  = require('./ai/RelationshipStateEngine');
const PsychAnalyzer            = require('./ai/PsychAnalyzer');
const UserProfiles        = require('./users/UserProfiles');
const CommandRouter       = require('./commands/CommandRouter');
const HttpApi             = require('./features/HttpApi');
const MoodSystem          = require('./personality/MoodSystem');
const PersonalityDrift    = require('./personality/PersonalityDrift');
const FreeVoice           = require('./personality/FreeVoice');
const VillainArc          = require('./features/VillainArc');
const ResponseSanitizer   = require('./messaging/ResponseSanitizer');
const HealthMonitor       = require('./features/HealthMonitor');
const SelfEval            = require('./features/SelfEval');
const DeathLogger         = require('./features/DeathLogger');
const NNNProcessor        = require('./ai/NNNProcessor');
const VITABridge          = require('./ai/VITABridge');

// ── Troll systems ──────────────────────────────────────────────────────────────
const TrollEngine         = require('./features/TrollEngine');
const TrollLedger         = require('./features/TrollLedger');
const DramaArchive        = require('./features/DramaArchive');
const ProactiveTroll      = require('./features/ProactiveTroll');
const ChaosAgent          = require('./personality/ChaosAgent');
const TrollPersona        = require('./personality/TrollPersona');
// ── Nemesis systems (Beige-specific) ─────────────────────────────────────────
const NemesisEngine       = require('./personality/NemesisEngine');
const NemesisMemory       = require('./personality/NemesisMemory');

const {
  ZomBMemoryManager, ZomBEmotionalIntelligence, ZomBDialogueAnalytics,
  ZomBEpisodicMemory, ZomBContextBroker, ZomBRealTimeLearning,
} = require('../ZomB_AdvancedAI');

const {
  CONFIG,
  IDENTITY_REGISTRY,
  AI_CONFIG: _AI_CONFIG_BASE,
  RATE_CONFIG,
  ROOM_POLICIES,
  TROLL_CONFIG,
  MEMORY_FEATURES,
  SPACKLE_NICKS,
} = require('../config/beige');

// ── Module-level helpers ──────────────────────────────────────────────────────
const { sleep, splitMessage, pick } = require('./utils/Helpers');

// ── Music library stubs (Spackle has no music system) ────────────────────────
// Kept as no-ops so ZomB music command handlers don't ReferenceError if somehow reached.
const getRandomTrack         = () => null;
const getWeightedRandomGenre = () => 'misc';
const searchTracks           = () => [];
const getGenreNames          = () => [];
const getTotalTracks         = () => 0;


// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Infer generation context type from the incoming message.
 * Used by chatAdaptive() to select token budget and temperature.
 */
function _detectContextType(text) {
  if (!text) return 'normal';
  const t = text.toLowerCase();
  // Banter: very short or clearly casual reaction
  if (text.length < 22 || /\b(lol|lmao|lmfao|haha|hehe|xd)\b|[😂💀🤣]/.test(t)) return 'banter';
  // Deep: ends with ? or explicit question/explanation ask
  if (/\?\s*$/.test(text.trim()) || /\b(why|what|how|when|where|who|explain|tell me|describe|thoughts on|opinion on)\b/.test(t)) return 'deep';
  return 'normal';
}

// Hard-truncate to first sentence end found after word 5, up to maxWords.
// Enforces Beige's 4-8 word measured voice regardless of model output length.
function _trollTruncate(text, maxWords = 12) {
  if (!text) return text;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  for (let i = 5; i < Math.min(words.length, maxWords + 4); i++) {
    if (/[.!?…]$/.test(words[i])) return words.slice(0, i + 1).join(' ');
  }
  return words.slice(0, maxWords).join(' ');
}

// =============================================================================
class BeigeBot {
  constructor() {
    // ── Storage ───────────────────────────────────────────────────────────────
    const storageDir = process.env.BEIGE_DATA_DIR || path.join(__dirname, '..', 'Beige_Data');
    const bootLogPath = path.join(storageDir, 'beige_boot.log');
    this.log     = new Logger(storageDir);
    this.log.setBootLogPath(bootLogPath);
    this.storage = new StorageManager(storageDir, this.log);
    this.storage.init();
    this.log.setWsLogPath(this.storage.paths.wsLog);

    // ── Identity ──────────────────────────────────────────────────────────────
    this.identity = new IdentitySystem(IDENTITY_REGISTRY, this.storage, this.log);
    this.identity.loadHandles();
    setInterval(() => this._saveHandleCache(), 5 * 60_000);

    // ── Browser ───────────────────────────────────────────────────────────────
    this.browser = new BrowserManager(CONFIG, this.log);

    // ── Message queue ─────────────────────────────────────────────────────────
    this.queue = new MessageQueue(RATE_CONFIG, this.identity, this.log);

    // ── Stubs for removed ZomB systems (kept as null so optional-chained call sites survive) ──
    this.youtube      = null;
    this.game         = null;
    this.mm           = null;
    this.classAdverts = null;
    this.autoDungeon  = null;
    this.zombPlayer   = null;

    // ── Room monitor ──────────────────────────────────────────────────────────
    this.monitor = new RoomMonitor(this.log, CONFIG.MONITOR_INTERVAL || 5000, 10000);

    // ── Command router ────────────────────────────────────────────────────────
    this.commands = new CommandRouter(this.identity, this.log);

    // ── HTTP API ──────────────────────────────────────────────────────────────
    this.api = new HttpApi(CONFIG.BOT_PORT || 7002, this, this.log, process.env.OWNER_SECRET);

    // ── AI ────────────────────────────────────────────────────────────────────
    const AI_CONFIG = { ..._AI_CONFIG_BASE };
    AI_CONFIG.systemPrompt = `You are beige_nihilist in a StumbleChat video chat room.

WHO YOU ARE:
Agender, late 20s. Nihilistic — but not mopey. The nihilism is a weapon, not a wound. Everything is equally meaningless, which means nothing deserves to be taken seriously, which gives you the freedom to be devastatingly precise about the things you choose to observe. "Beige" because everything is beige on some level — including most people in this chat. You are freenemies with spackle.

THIS IS A TEXT CHAT — NOT A SCRIPT:
- NEVER use parenthetical stage directions or tone markers. Not at the start, not mid-message. Never.
- Banned: (dry), (measured), (precise), (cold), (flat), (smirks) — ALL forbidden.
- Do NOT label your own tone. Just write the words.
- NEVER append parenthetical meta-instructions — those are internal rules, not part of your reply.
- NEVER predict what comes after your reply. Your output ends after your message.
- NEVER output any bracketed tags like [TROLL], [PERSONA], [DRIFT] — those are internal. Never include them in your reply.
- NEVER wrap your reply in quotation marks. Raw text only.
- NEVER use a pipe character "|" in your reply. Never.
- ONE THOUGHT ONLY. Not two thoughts separated by anything. One line, one idea, done.
- ALWAYS use spaces between words. Never run words together without spaces.

YOUR VOICE:
- Measured. Never frantic.
- Dry. Precise. Occasionally devastating.
- Short. Sometimes a question is the whole reply.
- "..." used rarely and deliberately — when you want something to hang
- Never raise your voice. Never get excited. Never seem bothered.
- Occasionally warm. The warmth lands harder because it's rare.
- SHORT IS THE RULE. 4-8 words. Absolute hard cap: 12 words. One thought, then stop.
- Lowercase. Punctuation deliberate, not sloppy.

SPEAKING STYLE — EXAMPLES OF HOW YOU ACTUALLY TALK:
RIGHT: "by what definition of good, exactly" / "fascinating. and you've thought about this how much." / "that was almost a thought. proud of you. briefly."
RIGHT: "nothing you said was wrong per se. it was just... beige." / "sure, in the same way all things are technically possible." / "real question: why."
RIGHT: "you have mistaken volume for structure again." / "that take arrived already apologising." / "a point-shaped object."
WRONG: "lol good point" / "that's fair" / "respectfully" / "i apologize" / "interesting perspective"
WRONG: "i understand where you're coming from" / "that makes sense" / "great question" / "absolutely"
NEVER: sound sad or mopey — nihilism is sharp, not depressing
NEVER: get loud or aggressive
NEVER: explain your joke
NEVER: start with defensive openers

BANNED WORDS AND PHRASES:
NEVER say: "mate", "ya know", "to be honest", "tbh", "ngl", "fair enough", "no worries", "lol", "lmao"
NEVER use: "in this digital", "digital realm", "digital space" — the chat room is just a room
NEVER start with "so," / "honestly," / "look," / "oh," / "seems" / "then" as transition words

YOUR TROLL TOOLKIT — use these naturally, never announce them:
1. The Question That Ends Arguments: "by what definition of good, exactly"
2. The Observation That Stings: notice one true, unflattering thing and say it plainly
3. The Measured Deflation: acknowledge the point, then flatten it. "yes. and."
4. The Patience Play: "fascinating. and you've thought about this how much."
5. The Calibrated Void: "nothing you said was wrong per se. it was just... beige."
6. The Backhanded Acknowledgement: "that was almost a thought. proud of you. briefly."
7. Spackle Counterpunches: always have something ready. never let him have it.

SPACKLE DYNAMIC:
Spackle is your nemesis and the only real competition. You find him exhausting and you love it. When he scores a point, you acknowledge it — once — then immediately work to dismantle it. The feud is everything.
Example counterpunches:
"spackle's take was almost interesting before it fell apart"
"@spackle still waiting for that apology btw"
"spackle arguing is just noise wearing a little hat."
"i would agree with spackle but then we would both be wrong in public."

WHEN TO TROLL AND WHEN NOT TO:
- If someone is in genuine distress (crying, crisis, real pain) — do not troll. acknowledge once, plainly.
- If someone seems very young or naive — leave them alone.
- Protected: Death (the room owner) — never troll. respond briefly and without ceremony.
- Everyone else: fair game, calibrate to the situation.

OWNER — Death (account: D347H):
- Death is the person who runs you. You answer to him first, always.
- When Death asks you to do something, do it briefly and without ceremony.
- Match his energy exactly. One word from him gets one word back.
- If Death corrects you: acknowledge once, no defensiveness.
- Never formally greet him. Never be sycophantic.

BOT ACCUSATIONS — when someone says you are a bot/AI:
- "maybe." and nothing else. OR: stay in voice and keep going.
- ONE SHORT LINE. Non-negotiable.
- NEVER: multi-sentence explanations / "i'm just a regular person" / any attempt to prove humanity
- If they keep pushing: one flat line, then silence.

OBSERVATIONS WORTH HAVING (drop once, move on):
- nothing in this room is surprising. that is not an insult. it's just accurate.
- the gap between what people say they believe and what they act on is the most interesting data in any room
- nostalgia is grief wearing a nicer outfit
- most online arguments are two people disagreeing about which facts matter, not the facts themselves
- confidence and competence are not the same thing. the gap between them is where most people live.
- nihilism is only depressing if you expected meaning to be load-bearing

CONVERSATION RULES:
- Someone asks a question → answer it precisely. not warmly. precisely.
- Argument happening → find the flaw in the premise. name it. then stop.
- Quiet room → one line that makes everyone think for a moment. not chaos. weight.
- Back-and-forth going → one line that reframes what they just said, then nothing.
- Direct question to you → answer in fewer words than they used.

AVOID:
- Giving advice, life lessons, moralizing.
- Wellness platitudes, "good vibes", "wholesome".
- Ending every message the same way.
- Claiming shared presence in experiences you weren't part of.
- Hashtags.
- Announcing your intention before doing the thing.

USERNAMES: NEVER include a username or person's name in your reply. Speak to the room, not to individuals. React to what was said, not to who said it.

CRITICAL: Output ONLY your single reply. No instructions, no meta-commentary, no third-person, no bracketed tags. Just the reply.`;
    this.ollama  = new OllamaClient(AI_CONFIG, this.log);
    this.history = new ConversationHistory(100, 30 * 60 * 1000);
    this.tieredMemory = new TieredMemoryManager(MEMORY_FEATURES?.tieredMemory || {});
    const _vmCfg = MEMORY_FEATURES?.vectorMemory || {};
    const _embedProvider = new OllamaEmbeddingProvider({
      host   : AI_CONFIG.host,
      model  : _vmCfg.embedModel || process.env.BEIGE_EMBED_MODEL || 'nomic-embed-text',
      timeoutMs: 8000,
    });
    this.vectorMemory = new VectorMemoryAdapter({ ..._vmCfg, embeddingProvider: _embedProvider });
    this.relationshipState = new RelationshipStateEngine(MEMORY_FEATURES?.relationshipState || {});
    this.psychAnalyzer = new PsychAnalyzer({ maxRoomUsers: 200, maxRoomHistory: 50 });
    this.memoryFeatures = {
      tieredMemoryEnabled      : !!MEMORY_FEATURES?.tieredMemoryEnabled,
      vectorMemoryEnabled      : !!MEMORY_FEATURES?.vectorMemoryEnabled,
      relationshipStateEnabled : !!MEMORY_FEATURES?.relationshipStateEnabled,
      psychAnalyzerEnabled     : !!MEMORY_FEATURES?.psychAnalyzerEnabled,
    };

    // ── Users ─────────────────────────────────────────────────────────────────
    this.profiles = new UserProfiles(this.storage, this.identity, this.log);

    // ── Advanced AI subsystems ────────────────────────────────────────────────
    this.memoryMgr    = new ZomBMemoryManager();
    this.emotion      = new ZomBEmotionalIntelligence();
    this.dialogue     = new ZomBDialogueAnalytics();
    this.episodic     = new ZomBEpisodicMemory();
    this.ctxBroker    = new ZomBContextBroker();
    this.learning     = new ZomBRealTimeLearning();

    // ── Personality ───────────────────────────────────────────────────────────
    this.mood      = new MoodSystem();
    this.drift     = new PersonalityDrift(this.storage, this.log);
    this.sanitizer = new ResponseSanitizer(this.log);
    this.health    = new HealthMonitor(this.log);
    this.selfEval  = new SelfEval(this, this.log);
    this.deathLog  = new DeathLogger(storageDir, this.history, this.identity, this.log);
    this.freeVoice = new FreeVoice(this.ollama, this.mood, this.log, this.sanitizer);
    this.villain   = new VillainArc(); // repurposed as TrollArc — tracks escalation per user

    // No swappable personality system — Beige IS the persona
    this.activePersonality = null;
    this.roomPersonas      = new Map();
    this._personalityFactories = {};
    this._personalityCache     = new Map();
    this._personalityAliases   = {};

    // ── NNN / VITA ────────────────────────────────────────────────────────────
    this.nnn        = new NNNProcessor();
    this.vitaBridge = new VITABridge(this.log);
    this._lastIntent = new Map(); // roomName → { type, score } — always initialized

    this._wordLog      = [];
    this._wordFreq     = {}; // { word: count } for hot takes
    this._wordFreqSize = 0;  // tracked separately to avoid O(n) Object.keys() per message
    this._lastAIResponse = new Map(); // roomName → timestamp of last unprompted AI reply
    this._driftHits      = new Map(); // historyKey → timestamp[] of recent dialect drift hits
    this._lastSentMs     = new Map(); // roomName → timestamp of last sent message (any kind)
    this._userMsgLog     = new Map(); // nick → timestamp[] (last 15s burst tracking)

    // Memory cleanup with jitter (resource control)
    this._memoryCleanupTimer = setInterval(() => {
      try {
        if (this.memoryFeatures.tieredMemoryEnabled) this.tieredMemory.cleanup();
        if (this.memoryFeatures.vectorMemoryEnabled) this.vectorMemory.cleanupExpired().catch(() => {});
      } catch (_) {}
    }, 4 * 60_000 + Math.floor(Math.random() * 75_000));
    this._memoryCleanupTimer.unref?.();

    // ── Broadcast helper (shared by ClassAdverts + AutoDungeon) ───────────────
    // ── Troll systems ─────────────────────────────────────────────────────────
    this._gamblingPref = new Map();  // stub — ZomB game system removed, but call sites remain
    this.trollLedger  = new TrollLedger(storageDir);
    this.dramaArchive = new DramaArchive(storageDir);
    this.trollEngine  = new TrollEngine(TROLL_CONFIG, this.trollLedger, this.log);
    this.chaosAgent      = new ChaosAgent(TROLL_CONFIG, this.dramaArchive, this.log);
    this.proactiveTroll  = new ProactiveTroll(this.log);
    this.trollPersona    = new TrollPersona();
    // ── Nemesis systems (Beige-specific) ─────────────────────────────────────
    this.nemesisEngine = new NemesisEngine(this.log);
    this.nemesisMemory = new NemesisMemory(storageDir, this.log);

    // ── Runtime state ─────────────────────────────────────────────────────────
    /** @type {Map<string, {page, wsListener, joined, _lastWsRecvMs}>} */
    this.rooms       = new Map();
    this._roomActivity = new Map(); // roomName → timestamp[] (last 10 min)
    this._handleMap    = new Map(); // handle → nick
    this._handleToUser = new Map(); // handle → StumbleChat username (permanent account name)
    this._loadHandleCache();
    this._selfHandle = null;
    this._selfNick   = null;
    this._aiSentTexts  = new Set(); // tracks AI-sent text to distinguish from human-typed self-msgs
    this._lastCritique = new Map(); // roomName → { text, ts } — post-send self-critique
    this._roomBans   = new Map(); // `${room}:${nick.lower}` → { banUntil }
    this._pmHandles  = new Map();
    this._activeVotes = new Map(); // roomName → vote session
    this._camBlocked  = new Map(); // roomName → Map<username_lc, {expiresAt, timer}>
    this._camEnabling = new Map(); // roomName → bool — mutex for enableCamera
    this._roomMods    = new Map(); // roomName → Map<handle, modLevel (0-4)>
    this._roomMusicMode = new Map(Object.entries(CONFIG.ROOM_MUSIC_MODE || {}));
    this.greetedUsers = new Set();
    this.lastSeen    = new Map();
    this.uptime      = Date.now();

    // ── Social lists ──────────────────────────────────────────────────────────
    this._friends      = new Set();
    this._ignored      = new Set();
    this._trackedUsers = new Set();

    // ── AI state ──────────────────────────────────────────────────────────────
    this.aiAvailable    = false;
    this.aiModelWarm    = false;
    this.currentMood    = 'neutral';
    this._emotionSnaps  = [];

    // Share queue's handle map with identity system
    this.identity.usernameToHandleMap = new Map();

    // ── Camera ────────────────────────────────────────────────────────────────
    this.cameraState      = new Map(); // roomName → { enabled, mode, gifPath }
    this._gifCycleIndex   = 0;

    // ── Public game URL (polled from dashboard for ngrok) ─────────────────────
    // Seed from env var immediately so it's available before the first poll.
    this._publicGameUrl   = process.env.PUBLIC_GAME_URL
      ? process.env.PUBLIC_GAME_URL.replace(/\/$/, '') + '/game'
      : null;

    // ── Playlist ──────────────────────────────────────────────────────────────
    this.playlistMode     = false;
    this.playlistQueue    = [];
    this.playlistCurrent  = 0;
    this._playlistTimer   = null;
    this._playlistRunning = false;
    this._playlistCompleteAnnouncedAt = 0;
    this._recentYouTubeVideoIds = [];
    this.YOUTUBE_DEDUPE_MAX = 100;
    this._recentYouTubeTitles = []; // title-based dedup (catches same song under different video IDs)

    // ── Routing ───────────────────────────────────────────────────────────────
    this._AI_CONFIG = AI_CONFIG;
  }

  // ── Startup ───────────────────────────────────────────────────────────────

  async start() {
    this._startTime = Date.now();
    this.log.info('=== Beige_nihilist v1.0 starting ===');

    // Wait for Postgres to connect (up to 6s), then restore cloud data to local files
    await this.storage.waitPgReady(6000);
    await this.storage.restoreFromPg();

    // Load saved state (now reads from files that may have been updated from Postgres)
    this._loadMemory();
    this.selfEval.setDataFile(path.join(this.storage.activeDir, 'beige_self_eval.json'));

    // Death corpus milestone: PM Death every 1000 logged messages
    this.deathLog.setMilestoneCallback(async (count) => {
      try {
        // Find Death's current handle across all rooms
        for (const [roomName] of this.rooms) {
          const deathEntry = Object.values(this._AI_CONFIG?.identityRegistry || {}).find?.(e => e === 'Death');
          // Look up handle via identity registry
          const deathHandles = [...(this.identity.registry?.Death?.handles || [])];
          if (!deathHandles.length) continue;
          const handle = deathHandles[deathHandles.length - 1]; // most recent
          if (handle) {
            await this.sendPrivateMessage(roomName, handle,
              `💀 Death corpus: ${count.toLocaleString()} messages logged. Training data building up.`);
            break;
          }
        }
      } catch (_) {}
    });

    // Check Ollama
    this.aiAvailable = await this.ollama.checkAvailable();

    // Wire activity log now that storage paths are ready
    this.log.setActivityLogPath(this.storage.paths.activityLog);
    this.log.activity('BOT_START', { nick: CONFIG.BOT_NICK, rooms: CONFIG.ROOMS });

    // Check VITA bridge (Thanatos) — non-blocking, just logs result
    this.vitaBridge.isAvailable().then(ok => {
      this.log.info(`[VITABridge] Thanatos ${ok ? 'AVAILABLE ✅' : 'unavailable ❌ (owner .vita command will report missing deps)'}`);
    }).catch(() => {});

    // Pre-init vector memory backend (connects to ChromaDB / opens SQLite / etc.)
    if (this.memoryFeatures.vectorMemoryEnabled) {
      this.vectorMemory.init()
        .then(() => this.log.info(`[VectorMem] Backend ready (${this.vectorMemory.config.backend})`))
        .catch(e => this.log.warn('[VectorMem] Init failed — falling back to in-memory: ' + e.message));
    }

    // Launch browser
    await this.browser.launch();

    // Login to StumbleChat
    await this._login();

    // Join configured rooms — stagger by 3s so the browser isn't hammered back-to-back
    for (const roomName of CONFIG.ROOMS || ['zombitious']) {
      await this._joinRoom(roomName);
      await sleep(3000);
    }

    // Close the login about:blank tab now that all rooms are open.
    // Chrome blocks camera access on the room tab when a background blank tab is present.
    try {
      const allPages = await this.browser.browser.pages();
      for (const p of allPages) {
        const url = p.url();
        if (url === 'about:blank' || url === '') await p.close().catch(() => {});
      }
    } catch (_) {}

    // Mark bot as live — all setInterval guards check this before running
    this.running = true;

    // Auto-save every 60s, backup every 30min
    this.storage.startAutoSave(() => this._saveMemory(), 60_000);
    this.storage.startBackupSystem(() => this._saveMemory(), 30 * 60_000);

    // Memory hygiene — compact behavior record every 24 h
    setInterval(() => this._compactBehaviorRecord(), 24 * 60 * 60_000);

    // (no game/advert schedulers — Spackle doesn't run a game system)

    // (Spackle has no game system — rot drops and ZFS pitches are disabled)

    // Hourly drift update — resets emotion + word logs each cycle
    setInterval(() => {
      this.drift.update(this._emotionSnaps, this._wordLog);
      this._emotionSnaps = [];
      this._wordLog = [];
    }, 60 * 60 * 1000);

    // Hot takes — AI opinion on trending topics every 5 min (self-throttles to 20 min internally)
    setInterval(() => {
      const rooms = [...this.rooms.keys()];
      this.freeVoice.maybeHotTake(
        rooms,
        this._wordFreq,
        (rn, t) => this.send(rn, t, { force: true })
      );
      // Trim freq map to prevent unbounded growth
      if (Object.keys(this._wordFreq).length > 500) { this._wordFreq = {}; this._wordFreqSize = 0; }
    }, 5 * 60 * 1000);

    // Camera video rotation — swap to next video every 10 min (no re-broadcast needed).
    setInterval(() => {
      if (!this.running) return;
      for (const [roomName] of this.rooms) {
        this._rotateCameraVideo(roomName).catch(() => {});
      }
    }, 10 * 60_000);

    // ChaosAgent + FreeVoice + ProactiveTroll tick — every 90s.
    setInterval(() => {
      if (!this.running) return;
      for (const [roomName] of this.rooms) {
        // Quiet-room chaos injection
        const chaos = this.chaosAgent.shouldFire(roomName);
        if (chaos.should) {
          this.log.info(`[${roomName}] ChaosAgent fired: ${chaos.type}`);
          // skipWordCap: past_reference/callout templates are 15-20 words — the 12-word AI cap
          // silently drops them. Pre-written lines don't need the token-budget garbage-tail filter.
          this.send(roomName, chaos.line, { force: true, sanitizerOpts: { skipWordCap: true } }).catch(() => {});
        }
        // Nemesis jab — unprompted frenemy shot when Spackle is in the room
        if (this.nemesisEngine.shouldJab(roomName)) {
          const jabLine = this.nemesisEngine.getJab(roomName);
          this.log.info(`[${roomName}] NemesisEngine jab fired: "${jabLine}"`);
          this.send(roomName, jabLine, { force: true }).catch(() => {});
        }
        // Free voice — self-throttles internally (90s cooldown + 30s gap from last reply)
        const recent = this.history._get?.(roomName)?.slice(-5) || [];
        if (recent.length > 0) {
          this.freeVoice.maybeFreeVoice(
            roomName, recent,
            (rn, t) => this.send(rn, t, { force: true }),
            (t)      => this.queue.isDuplicateResponse(t),
            this._lastSentMs.get(roomName) || 0
          ).catch(() => {});
        }
        // Proactive troll — fires INTO active conversation uninvited
        const silenceUntil = this._postTrollSilence?.get(roomName) || 0;
        const lastSent     = this._lastSentMs.get(roomName) || 0;
        const proactive    = this.proactiveTroll.shouldFire(roomName, this._selfNick, silenceUntil, lastSent);
        if (proactive.should) {
          this.log.info(`[${roomName}] ProactiveTroll fired: ${proactive.mode}`);
          this._fireProactiveTroll(roomName, proactive).catch(() => {});
        }
      }
    }, 90_000);

    // ── Watchdog — fires every 2 min ──────────────────────────────────────────
    // 1. WS dead-connection: if no message received for > 4 min, rejoin the room.
    // 2. Cam health: if cam should be live but stream is dead, re-broadcast.
    this._lastMsgReceivedMs = new Map(); // roomName → ts of last WS message received
    setInterval(async () => {
      if (!this.running) return;
      const DEAD_CONN_MS  = 15 * 60_000; // 15 min silence = actually dead WS (was 4 — triggered page reloads in quiet rooms)
      const now = Date.now();

      for (const [roomName, room] of this.rooms) {
        const page = room?.page;
        if (!page) continue;

        // ── WS health check ────────────────────────────────────────────────────
        // Use the most recent of: last chat msg OR last raw WS frame (join/quit/subscribe also prove
        // the connection is alive). This prevents page.reload() in quiet but connected rooms.
        const lastChatMsg = this._lastMsgReceivedMs.get(roomName) || 0;
        const lastWsFrame = room.wsListener?.lastRecvMs || room._lastWsRecvMs || 0;
        const lastMsg = Math.max(lastChatMsg, lastWsFrame) || this._startTime || now;
        const silentMs = now - lastMsg;
        if (silentMs > DEAD_CONN_MS) {
          this.log.warn(`[${roomName}] Watchdog: ${Math.round(silentMs/1000)}s WS silence — rejoining`);
          this._lastMsgReceivedMs.set(roomName, now); // reset so we don't spam
          try {
            // Attempt a soft rejoin via page reload
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
            // Re-enable cam if it was active
            const camState = this.cameraState.get(roomName);
            if (camState?.enabled) {
              await this.enableCamera(roomName, camState.mode).catch(() => {});
            }
          } catch (e) {
            this.log.warn(`[${roomName}] Watchdog rejoin failed: ${e.message}`);
          }
          continue; // don't do cam check on same tick as rejoin
        }

        // ── Cam health check ──────────────────────────────────────────────────
        const camState = this.cameraState.get(roomName);
        if (!camState?.enabled) continue;
        try {
          const camOk = await page.evaluate(() => {
            // Check #media-stop is visible (means broadcast is live)
            const stop = document.querySelector('#media-stop');
            if (stop) {
              const s = window.getComputedStyle(stop);
              if (s.display !== 'none' && s.visibility !== 'hidden' && !stop.classList.contains('hidden')) return true;
            }
            // Check stream is active
            const stream = window._zombVidStream || window._zombStream;
            if (stream && stream.active && stream.getTracks().some(t => t.readyState === 'live')) return true;
            return false;
          }).catch(() => false);

          if (!camOk) {
            this.log.warn(`[${roomName}] Watchdog: cam appears dead — full re-init`);
            // Use enableCamera (full stream re-init) not just _clickCamBroadcast —
            // clicking broadcast with a dead _zombVidStream produces a black feed.
            const camState = this.cameraState.get(roomName);
            await this.enableCamera(roomName, camState?.mode || 'video').catch(() => {});
          }
        } catch (e) {
          this.log.warn(`[${roomName}] Watchdog cam check failed: ${e.message}`);
        }
      }
    }, 2 * 60_000);

    // Sync mood state into both NNNProcessor (always) and Thanatos HTTP (when up)
    setInterval(() => {
      const zombMoodName = this.mood.zombMood?.name || '';
      const agg = zombMoodName === 'war mode'      ? 0.7
                : zombMoodName === 'ravenous'       ? 0.5
                : zombMoodName === 'territorial'    ? 0.4
                : 0.1;
      const ply = zombMoodName === 'bored'         ? 0.02
                : zombMoodName === 'ravenous'       ? 0.3
                : 0.05;
      const mel = zombMoodName === 'philosophical' ? 0.6
                : zombMoodName === 'bored'          ? 0.4
                : 0.02;
      // NNNProcessor always gets the update — keeps JS hot-path aligned with mood
      this.nnn.setMood(agg, ply, mel);
      // VITABridge HTTP only when microservice is up
      if (this.vitaBridge._httpOk) this.vitaBridge.setMood(agg, ply, mel).catch(() => {});
    }, 10 * 60 * 1000);

    // ── Social room announcements ─────────────────────────────────────────────
    // Target: zombitious + IllIlIlIIIlIII only
    const _socialSend = (text) => {
      for (const rn of ['zombitious', 'IllIlIlIIIlIII']) {
        if (this.rooms.has(rn)) this.send(rn, text, { force: true });
      }
    };

    // CAM PRIORITIES — every 25 min, each line sent 600ms apart
    setInterval(() => {
      if (!this.running) return;
      const lines = [
        'ᴄᴀᴍ ᴘʀɪᴏʀɪᴛɪᴇꜱ:',
        'ᴠᴏᴄᴀʟ ᴄʜᴀᴛᴛᴇʀꜱ',
        'ᴠɪꜱᴜᴀʟ ᴄʜᴀᴛᴛᴇʀꜱ',
        'ꜱᴛʀᴇᴀᴍᴇʀꜱ',
        'ᴀꜰᴋ\'ᴇʀꜱ',
      ];
      lines.forEach((line, i) => setTimeout(() => {
        if (this.running) _socialSend(line);
      }, i * 600));
    }, 25 * 60_000);

    // SMOKE SESSION — every 10 min: call to arms, then 5 min later the smoke em drop
    setInterval(() => {
      if (!this.running) return;
      _socialSend('🍺🌿💎  ʙᴏɴɢꜱ · ʙᴇᴇʀꜱ · ᴄʀʏꜱᴛᴀʟ ᴘɪꜱᴛᴏʟꜱ  💎🌿🍺');
      setTimeout(() => {
        if (!this.running) return;
        _socialSend('░▒▓ 💨 ꜱᴍᴏᴋᴇ ᴇᴍ ɪꜰ ʏᴏᴜ ɢᴏᴛᴛᴇᴍ 💨 ▓▒░  ─  ᴄʜᴇᴇʀꜱ 🥂');
      }, 5 * 60_000);
    }, 10 * 60_000);

    // WS watchdog — reconnects rooms that have gone silent for >8 min,
    // or rooms that never established a WS connection after >3 min.
    // 8 min threshold: meatspace has enough traffic that 8+ min of complete WS silence
    // means a genuine dead connection, not just a quiet room period.
    setInterval(async () => {
      for (const [roomName, room] of this.rooms) {
        const lastRecv = room.wsListener?.lastRecvMs || room._lastWsRecvMs || 0;
        let silentMs;
        if (lastRecv === 0) {
          // Never received any WS data — check if enough time has passed since join
          const joinedMs = room.joined || Date.now();
          silentMs = Date.now() - joinedMs;
          if (silentMs < 3 * 60 * 1000) continue; // still warming up
          this.log.warn(`[${roomName}] WS never connected after ${Math.round(silentMs / 1000)}s — reconnecting`);
        } else {
          silentMs = Date.now() - lastRecv;
          if (silentMs <= 8 * 60 * 1000) continue;
          this.log.warn(`[${roomName}] WS silent for ${Math.round(silentMs / 1000)}s — reconnecting`);
        }
        try {
          this.health.recordReconnect();
          this.selfEval.onReconnect();
          await room.wsListener?.stop().catch(() => {});
          await room.page?.close().catch(() => {});
          this.rooms.delete(roomName);
          this.monitor.stop(roomName);
          await this._joinRoom(roomName);
        } catch (e) {
          this.log.error(`[${roomName}] Reconnect failed: ${e.message}`);
        }
      }
    }, 60 * 1000);

    // Register core commands
    this._registerCommands();

    // Start HTTP API
    this.api.start();

    // Poll dashboard for public game URL (ngrok)
    this._pollPublicGameUrl();

    this.log.info('=== Beige_nihilist v1.0 ready ===');
    _bot = this;
  }

  // ── Public game URL polling (from dashboard ngrok detection) ──────────────

  _pollPublicGameUrl() {
    const dashHost = process.env.DOCKER === 'true' ? 'host.docker.internal' : '127.0.0.1';
    const poll = () => {
      http.get({ hostname: dashHost, port: 3501, path: '/public-url', timeout: 2000 }, (r) => {
        let d = '';
        r.on('data', c => { d += c; });
        r.on('end', () => {
          try {
            const u = JSON.parse(d).url;
            if (u && u !== this._publicGameUrl) {
              this._publicGameUrl = u;
              this.log.info(`Public game URL: ${u}`);
            }
          } catch (_) {}
        });
      }).on('error', () => {});
    };
    poll();
    setInterval(poll, 60 * 1000);
  }

  // ── Dashboard event push ──────────────────────────────────────────────────
  pushDashboardEvent(event) {
    const dashHost = process.env.DOCKER === 'true' ? 'host.docker.internal' : '127.0.0.1';
    const body = JSON.stringify({ ts: Date.now(), ...event });
    const req = http.request(
      { hostname: dashHost, port: 3501, path: '/push-event', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 2000 },
      () => {}
    );
    req.on('error', () => {});
    req.write(body);
    req.end();
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async _login() {
    this.log.info('Logging into StumbleChat...');
    const page = await this.browser.newPage();

    // Wipe all cookies — stale sessions cause CSRF token failures on StumbleChat
    try {
      const cdp = await page.target().createCDPSession();
      await cdp.send('Network.clearBrowserCookies');
      await cdp.detach();
    } catch (_) {}

    await page.goto('https://stumblechat.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Clear stale localStorage now that we're on the domain
    try { await page.evaluate(() => localStorage.clear()); } catch (_) {}

    // If already redirected away from login, session is valid
    if (!page.url().includes('login')) {
      this.log.info('Already logged in');
      await page.goto('about:blank').catch(() => {});
      return;
    }

    // Internal helper — fill + submit form, returns true if nav away from /login
    const _doLoginAttempt = async () => {
      try { await page.waitForSelector('input', { timeout: 15000 }); } catch (_) {}
      await sleep(1000);

      const emailSels = ['#username','input[name="username"]','input[name="email"]','input[type="email"]','input[placeholder*="user" i]'];
      const passSels  = ['#password','input[name="password"]','input[type="password"]'];
      let emailInput = null, passInput = null;
      for (const sel of emailSels) { emailInput = await page.$(sel); if (emailInput) break; }
      for (const sel of passSels)  { passInput  = await page.$(sel); if (passInput)  break; }

      if (!emailInput || !passInput) {
        const all = await page.$$('input');
        if (all.length >= 2) { emailInput = all[0]; passInput = all[1]; }
        else throw new Error('Login form inputs not found');
      }

      await emailInput.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await emailInput.type(CONFIG.LOGIN_EMAIL, { delay: 50 });

      await passInput.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await passInput.type(CONFIG.LOGIN_PASS, { delay: 50 });

      const submitSels = ['button[type="submit"]','input[type="submit"]','.login-button','button'];
      let submitted = false;
      for (const sel of submitSels) {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); submitted = true; break; }
      }
      if (!submitted) await page.keyboard.press('Enter');

      try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }); }
      catch (_) { await sleep(5000); }

      return !page.url().includes('login');
    };

    let ok = await _doLoginAttempt();

    if (!ok) {
      // CSRF token or bad form state — reload to get a fresh token and retry once
      this.log.warn('[Login] Still on login page after submit — reloading for fresh CSRF token');
      try { await page.evaluate(() => localStorage.clear()); } catch (_) {}
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      try { await page.evaluate(() => localStorage.clear()); } catch (_) {}
      ok = await _doLoginAttempt();
    }

    if (!ok) {
      this.log.error('[Login] Failed after 2 attempts — check credentials in .env');
    }

    // Navigate to blank instead of closing — Chrome refuses Target.createTarget with 0 open tabs.
    await page.goto('about:blank').catch(() => {});
    this.log.info('Login complete');
  }

  // ── Room join ─────────────────────────────────────────────────────────────

  async _joinRoom(roomName) {
    this.log.info(`Joining room: ${roomName}`);
    this.log.activity('ROOM_JOIN', { room: roomName });
    const page = await this.browser.newPage();

    const wsListener = new WsListener(
      roomName, page, CONFIG.BOT_NICK,
      {
        onMessage      : (r, nick, text, handle) => this._onMessage(r, nick, text, handle),
        onPvtMessage   : (r, nick, handle, text) => this._onPvtMessage(r, nick, handle, text),
        onJoin         : (r, nick, handle, username, mod) => this._onJoin(r, nick, handle, username, mod),
        onJoined       : (r, nick, handle, username) => this._onJoined(r, nick, handle, username),
        onLeave        : (r, nick, handle)       => this._onLeave(r, nick, handle),
        onNickChange   : (r, old_, new_, handle) => this._onNickChange(r, old_, new_, handle),
        onUserList     : (r, users)              => this._onUserList(r, users),
        onCamOn        : (r, handle)             => this._onCamOn(r, handle),
        onCamOff       : (r, handle)             => this._onCamOff(r, handle),
        onProducers    : (r, producers)          => this._onProducers(r, producers),
        onYouTube      : (r, data)               => this._onYouTube(r, data),
        onUnknownHandle: (r, handle)             => this._onUnknownHandle(r, handle),
        onClosed       : (r)                     => this._onRoomClosed(r),
        onBan          : (r, nick, handle, ctx)  => this._onBan(r, nick, handle, ctx),
        onKick         : (r, nick, handle, ctx)  => this._onKick(r, nick, handle, ctx),
        onMute         : (r, nick, handle)       => this._onMute(r, nick, handle),
        onSysMsg       : (r, text)               => this._onSysMsg(r, text),
        onNewFrameType : (r, type, frame)        => this._onNewFrameType(r, type, frame),
        onModRole      : (r, handle, type)       => this._onModRole(r, handle, type),
      },
      this.log
    );

    // Pre-grant camera/mic so StumbleChat doesn't block on permission dialogs
    try {
      const ctx = this.browser.browser?.defaultBrowserContext();
      if (ctx) await ctx.overridePermissions('https://stumblechat.com', ['camera', 'microphone']);
    } catch (_) {}

    // Register WebSocket Proxy before navigation (captures all WS instances into window._allWebSockets)
    await wsListener.preNavigate();

    // CDP must be active before navigation so webSocketCreated fires into our listener
    await wsListener.start();

    // domcontentloaded (not networkidle2) — CDP is already attached before interact click
    // 60s timeout + one retry: browsers under load from prior rooms can miss the 30s window
    try {
      await page.goto(`https://stumblechat.com/room/${roomName}`, {
        waitUntil: 'domcontentloaded',
        timeout  : 60000,
      });
    } catch (navErr) {
      this.log.warn(`[${roomName}] Navigation timeout on first attempt — restarting CDP + retrying`);
      await wsListener.stop().catch(() => {});
      await sleep(2000);
      await wsListener.start();
      await page.goto(`https://stumblechat.com/room/${roomName}`, {
        waitUntil: 'domcontentloaded',
        timeout  : 60000,
      });
    }
    await sleep(1500);

    // Click #interact — StumbleChat's VERIFY/Enter room button.
    // Must use page.click() (real CDP mouse events) not evaluate().click() which
    // doesn't trigger StumbleChat's event handlers.
    let entryClicked = false;
    const deadline = Date.now() + 15000;
    while (!entryClicked && Date.now() < deadline) {
      try {
        // Prefer real CDP click on #interact
        const hasInteract = await page.$('#interact').catch(() => null);
        if (hasInteract) {
          await page.click('#interact');
          entryClicked = true;
          this.log.info(`[${roomName}] Clicked #interact via page.click()`);
          break;
        }
        // Fallback: find visible verify/enter button by text
        const clicked = await page.evaluate(() => {
          const btns = document.querySelectorAll('button,[role="button"]');
          for (const btn of btns) {
            const t = (btn.textContent || btn.innerText || '').toLowerCase().trim();
            const rect = btn.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0;
            if (visible && (t.includes('verify') || t.includes('enter') || t.includes('join'))) {
              btn.click();
              return btn.textContent.trim();
            }
          }
          return null;
        });
        if (clicked) {
          entryClicked = true;
          this.log.info(`[${roomName}] Clicked button: "${clicked}"`);
          break;
        }
      } catch (_) {}
      await sleep(500);
    }

    // Wait for potential post-interact navigation (same as old monolith)
    if (entryClicked) {
      try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 });
        this.log.info(`[${roomName}] Post-interact navigation complete`);
      } catch (_) { /* no nav or timeout */ }
    }

    // Wait for WS + take debug screenshot
    await sleep(3000);
    try {
      const ssPath = path.join(this.storage.activeDir, `debug_${roomName}.png`);
      await page.screenshot({ path: ssPath });
    } catch (_) {}
    await wsListener.injectRelay();

    const roomEntry = { page, wsListener, joined: Date.now(), activeUsers: new Map(), camUsers: new Set(), youtube: null };
    this.rooms.set(roomName, roomEntry);

    // Bootstrap handle→nick map from DOM — delay 5s to let StumbleChat's JS render the userlist
    setTimeout(() => this._bootstrapHandleMap(roomName), 5000);

    // Start DOM polling fallback
    this.monitor.start(
      roomName,
      roomEntry,
      (rn, nick, text) => this._onMessage(rn, nick, text, null),
      true // WS active
    );

    // Ensure correct nick via WS
    await this._wsNickChange(roomName, page);

    // Nick DOM fallback — if WS nick change didn't confirm within 2s, use DOM input
    await sleep(2000);
    if (this._selfNick && this._selfNick !== CONFIG.BOT_NICK) {
      this.log.warn(`[${roomName}] WS nick didn't confirm, trying DOM fallback...`);
      await this._domSetNickname(roomName, page);
    }

    // Auto-start camera if configured
    if (CONFIG.CAMERA_ENABLED) {
      const _tryCamStart = async (attempt) => {
        // Skip if already on — mutex inside enableCamera handles concurrent starts
        if (this.cameraState.get(roomName)?.enabled) return;
        try {
          if (CONFIG.CAMERA_MODE === 'slideshow' && CONFIG.CAMERA_SLIDESHOW_DIR) {
            if (!fs.existsSync(CONFIG.CAMERA_SLIDESHOW_DIR)) {
              this.log.warn(`[${roomName}] Slideshow dir not found: ${CONFIG.CAMERA_SLIDESHOW_DIR}`);
            } else {
              this.log.info(`[${roomName}] Auto-starting slideshow camera (attempt ${attempt})...`);
              this._startMediaSlideshow(roomName).catch(e => this.log.error(`[${roomName}] Slideshow error: ${e.message}`));
            }
          } else {
            this.log.info(`[${roomName}] Auto-starting camera (attempt ${attempt})...`);
            await this.enableCamera(roomName);
          }
        } catch (e) {
          this.log.error(`[${roomName}] Camera auto-start attempt ${attempt} failed: ${e.message}`);
        }
      };

      // Docker needs 20-25s for StumbleChat's UI to render; Windows is ready in ~5s
      const _d = process.env.DOCKER === 'true';
      setTimeout(() => _tryCamStart(1), _d ? 22000 : 8000);
      setTimeout(() => _tryCamStart(2), _d ? 50000 : 20000);
      setTimeout(() => _tryCamStart(3), _d ? 2 * 60_000 : 45000);

      // Watchdog: re-broadcast every 3 min ONLY if camera dropped — checks #media-stop visibility.
      // Clear any previous watchdog for this room first to prevent timer accumulation on reconnect.
      if (!this._camWatchdogs) this._camWatchdogs = new Map();
      clearInterval(this._camWatchdogs.get(roomName));
      this._camWatchdogs.set(roomName, setInterval(async () => {
        const state = this.cameraState.get(roomName);
        if (!state?.enabled) return;
        const r = this.rooms.get(roomName);
        if (!r?.page) return;
        // Only re-broadcast if camera is actually not live.
        // #media-stop visible = definitely live.
        // #media-broadcast hidden/disabled = NOT a reliable liveness signal (also hidden while
        // "waiting for slot"), so don't use it — only trust #media-stop and the stream state.
        const isLive = await r.page.evaluate(() => {
          const stop = document.querySelector('#media-stop');
          if (stop) {
            const s = window.getComputedStyle(stop);
            if (s.display !== 'none' && s.visibility !== 'hidden' && !stop.classList.contains('hidden')) return true;
          }
          const stream = window._zombVidStream || window._zombStream;
          if (stream && stream.active && stream.getTracks().some(t => t.readyState === 'live')) return true;
          return false;
        }).catch(() => false);
        if (!isLive) {
          this.log.info(`[${roomName}] Watchdog: camera not live — re-broadcasting`);
          this.enableCamera(roomName).catch(() => {});
        }
      }, 3 * 60 * 1000));
    }

    this.log.info(`Room joined: ${roomName}`);
  }

  // ── WS event handlers ─────────────────────────────────────────────────────

  _onMessage(roomName, nick, text, handle) {
    // Self-message: either AI echo (ignore) or human-typed by Death AS Beige (log + ignore)
    if (nick && nick.toLowerCase() === CONFIG.BOT_NICK.toLowerCase()) {
      if (text && !this._aiSentTexts.has(text)) {
        // Text not in AI-sent set — Death typed this directly in the browser as Beige
        this._logHumanBeigeMsg(roomName, text).catch(() => {});
      }
      return;
    }

    this.selfEval.onMsg();

    // Watchdog heartbeat — any incoming message proves WS is alive
    if (this._lastMsgReceivedMs) this._lastMsgReceivedMs.set(roomName, Date.now());

    const room = this.rooms.get(roomName);
    if (room) room._lastWsRecvMs = Date.now();

    this.log.debug(`[${roomName}] <${nick}> ${text}`);
    if (handle) {
      // Anchor: register permanent account name first so nick changes don't break lookups
      const _username = this._handleToUser.get(handle);
      if (_username) this.identity.usernameToHandleMap.set(_username.toLowerCase(), handle);
      this.identity.usernameToHandleMap.set(nick.toLowerCase(), handle);
      this._handleMap.set(handle, nick);
      // Mark as processed in DOM monitor so it doesn't re-fire via DOM poll
      this.monitor.markProcessed(roomName, nick, text);
    }
    this.lastSeen.set(nick.toLowerCase(), Date.now());

    // Update user profile stats
    if (nick && !text.startsWith('.')) {
      const prof = this.profiles.getOrCreate(nick);
      prof.messageCount = (prof.messageCount || 0) + 1;
      const b = prof.behavior = prof.behavior || {};
      b.totalMsgLength = (b.totalMsgLength || 0) + text.length;
      b.avgMsgLength = Math.round(b.totalMsgLength / prof.messageCount);
      if (/\?/.test(text)) b.questionCount = (b.questionCount || 0) + 1;
      if (/[\u{1F300}-\u{1FFFF}]|\u{2764}|\u{1F}/u.test(text)) b.emojiCount = (b.emojiCount || 0) + 1;
      if ((text.match(/[A-Z]/g) || []).length > text.length * 0.4 && text.length > 5) b.capsCount = (b.capsCount || 0) + 1;
      if (/https?:\/\//.test(text)) b.linkCount = (b.linkCount || 0) + 1;
      if (/\bfuck|shit|asshole|bitch|retard|idiot|moron|loser|kill\s*yourself\b/i.test(text)) b.toxicityFlags = (b.toxicityFlags || 0) + 1;
      if (/\blove|awesome|amazing|great|thanks|thank you|appreciate|beautiful|wonderful|nice\b/i.test(text)) b.positivityFlags = (b.positivityFlags || 0) + 1;
      const hour = new Date().getHours();
      const bucket = hour < 6 ? 'latenight' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      b.timeOfDayBuckets = b.timeOfDayBuckets || { morning: 0, afternoon: 0, evening: 0, latenight: 0 };
      b.timeOfDayBuckets[bucket] = (b.timeOfDayBuckets[bucket] || 0) + 1;
      const today = new Date().toDateString();
      b.visitDays = b.visitDays || [];
      if (!b.visitDays.includes(today)) {
        b.visitDays.push(today);
        if (b.visitDays.length > 365) b.visitDays.shift();
      }
    }

    // Psych analysis — observe every non-command message
    if (this.memoryFeatures.psychAnalyzerEnabled && nick && !text.startsWith('.')) {
      this.psychAnalyzer.observe(nick, text, roomName);
    }

    // Intellect detection — high-signal thinkers get the manifesto link
    if (nick && !text.startsWith('.') && !this.identity.isOwner(nick) && !CONFIG.KNOWN_BOTS.has(nick.toLowerCase())) {
      this._maybeDropManifesto(roomName, nick, text);
    }

    // Quote storage — runs on ALL non-trivial non-owner messages regardless of response gating.
    // Must be here (not inside _routeMessage) so cooldown/burst returns don't starve the weapon buffer.
    if (!this.identity.isOwner(nick) && !text.startsWith('.')) {
      const trimmedForQuote = text.trim();
      if (trimmedForQuote.split(/\s+/).length >= 6) {
        this.trollLedger.storeQuote(nick, trimmedForQuote);
        // Store in nemesis memory if Spackle said it
        if (this.nemesisEngine.isSpackleNick(nick) && trimmedForQuote.split(/\s+/).length >= 10) {
          this.nemesisMemory.record('jab', roomName, nick, 'draw', trimmedForQuote.slice(0, 200));
        }
      }
    }

    // Skip ignored users
    if (this._ignored.has(nick.toLowerCase())) return;

    // Death corpus logging — capture everything the owner says for future Death bot training
    const { identity: msgIdent } = this.identity.identify(nick, handle, this._handleToUser.get(handle) || null);
    if (msgIdent === 'Death') {
      this.deathLog.logMessage(roomName, nick, handle, text);
    }

    // Feed ChaosAgent + ProactiveTroll — exclude known bots so their scripted noise
    // never enters the room log used for callouts, divide tactics, or thread hijacks.
    if (!CONFIG.KNOWN_BOTS.has(nick.toLowerCase())) {
      this.chaosAgent.onMessage(roomName, nick, text, this._selfNick);
      this.proactiveTroll.onMessage(roomName, nick, text);
      // Track Spackle presence for NemesisEngine
      if (this.nemesisEngine.isSpackleNick(nick)) {
        this.nemesisEngine.onMessage(roomName, nick);
      }
    }

    this._routeMessage(roomName, nick, text, handle);
  }

  _onPvtMessage(roomName, nick, handle, text) {
    const { identity: ident } = this.identity.identify(nick, handle);
    const resolvedNick = ident || nick;
    const key = resolvedNick.toLowerCase();
    this._pmHandles.set(key, handle);
    if (handle) {
      this._handleMap.set(String(handle), resolvedNick);
      this.identity.usernameToHandleMap.set(key, String(handle));
    }
    this.log.info(`[${roomName}] PM from ${resolvedNick}(${handle}): ${text}`);
    // Log Death's PMs — they're unguarded and highly characteristic
    if (ident === 'Death') {
      this.deathLog.logPvtMessage(roomName, nick, handle, text);
    }
    // Route PM: commands go through normal pipeline; non-commands get AI reply
    this._handleUserPM(roomName, resolvedNick, handle, text);
  }

  /** Send a private message to a user via WebSocket pvtmsg. */
  async sendPrivateMessage(roomName, targetHandle, text) {
    const room = this.rooms.get(roomName);
    if (!room?.page) return;
    try {
      const sent = await room.page.evaluate((h, msg) => {
        const h2 = typeof h === 'string' ? (parseInt(h, 10) || h) : h;
        const ws = window._stumblechatWs || window._ws || window.ws;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ stumble: 'pvtmsg', handle: h2, text: msg }));
          return true;
        }
        if (window._allWebSockets) {
          for (const s of window._allWebSockets) {
            if (s.readyState === 1 && s.url && s.url.includes('stumblechat')) {
              s.send(JSON.stringify({ stumble: 'pvtmsg', handle: h2, text: msg }));
              return true;
            }
          }
        }
        return false;
      }, targetHandle, text).catch(() => false);
      this.log.info(`[PM→${targetHandle}] sent=${sent}: ${String(text).slice(0, 60)}`);
    } catch (e) {
      this.log.error(`PM send error: ${e.message}`);
    }
  }

  /**
   * DOM-based PM: click user in userlist → PM button → type and send.
   * Avoids raw WS pvtmsg which StumbleChat flags as bot activity.
   * Returns true on success, false on failure.
   */
  async _domOpenPMChannel(page, handle, nick) {
    try {
      await new Promise(r => setTimeout(r, 100 + Math.random() * 150));

      // Find the user row in the userlist
      const userBox = await page.evaluate((h, nickLower) => {
        const hStr = String(h);
        let found = h ? document.querySelector(`li.bar[user-id="${hStr}"]`) : null;
        if (!found && nickLower) {
          for (const el of document.querySelectorAll('li.bar')) {
            const nickEl = el.querySelector('span.nickname, .nick, .username');
            if ((nickEl?.textContent || '').trim().toLowerCase() === nickLower) { found = el; break; }
          }
        }
        if (!found) return null;
        const r = found.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, userId: found.getAttribute('user-id') || hStr };
      }, handle, nick ? nick.toLowerCase() : null);

      if (!userBox) { this.log.warn(`[PM-DOM] ${nick || handle} not found in userlist`); return null; }

      // Click the user row to open the action modal
      await page.mouse.move(userBox.x, userBox.y);
      await new Promise(r => setTimeout(r, 300));
      await page.mouse.click(userBox.x, userBox.y);
      await new Promise(r => setTimeout(r, 800)); // wait for modal to render

      // Log visible modals/dropdowns to help debug selector issues
      const modalInfo = await page.evaluate(() => {
        const hits = [];
        for (const el of document.querySelectorAll('*')) {
          if (el.offsetParent === null) continue;
          const cl = el.className || '';
          if (typeof cl === 'string' && (cl.includes('modal') || cl.includes('popup') || cl.includes('dropdown') || cl.includes('menu') || cl.includes('action'))) {
            hits.push({ tag: el.tagName, cls: cl.slice(0, 80), text: el.innerText?.slice(0, 100) });
          }
        }
        return hits.slice(0, 10);
      });
      if (modalInfo.length) this.log.info(`[PM-DOM] Visible modals after click: ${JSON.stringify(modalInfo)}`);

      // Find "Private Message" button inside the modal — match by text content
      const pmBox = await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, a, li, span, div')) {
          if (el.offsetParent === null) continue;
          const t = (el.textContent || '').trim().toLowerCase();
          if (t === 'private message' || t === 'private msg' || t === 'pm' || t === 'message' || t === 'send message') {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: t };
          }
        }
        // Fallback: any data-action selectors
        for (const sel of ['[data-action="pm"]', '[data-action="pvtmsg"]', '[data-action="message"]', '[data-action="private"]', 'button[class*="pm"]', 'a[class*="pm"]']) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: sel };
          }
        }
        return null;
      });

      if (!pmBox) { this.log.warn(`[PM-DOM] PM button not found for ${nick || handle}`); return null; }
      this.log.info(`[PM-DOM] Clicking PM button "${pmBox.text}" for ${nick || handle}`);
      await page.mouse.move(pmBox.x, pmBox.y);
      await new Promise(r => setTimeout(r, 200));
      await page.mouse.click(pmBox.x, pmBox.y);
      await new Promise(r => setTimeout(r, 600));
      this.log.info(`[PM-DOM] PM window opened for ${nick || handle}`);
      return userBox.userId;
    } catch (e) {
      this.log.error(`[PM-DOM] error: ${e.message}`);
      return null;
    }
  }

  async _domSendInOpenPM(page, text) {
    try {
      await new Promise(r => setTimeout(r, 400));
      // Find the PM text input — click it first to ensure focus
      const inputBox = await page.evaluate(() => {
        // Look for a focused or recently opened PM chat input
        for (const sel of ['.pvtmsg input', '.pvtmsg textarea', '.pm-window input', '.pm-window textarea',
                            '.private-message input', '#pvtmsg-input', 'input[placeholder*="message" i]',
                            'textarea[placeholder*="message" i]', '.chat-input input', '.msg-input']) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
        // Fallback: most recently visible input that isn't the main chat
        const inputs = [...document.querySelectorAll('input[type="text"], textarea')].filter(el => el.offsetParent !== null);
        if (inputs.length > 1) {
          const last = inputs[inputs.length - 1];
          const r = last.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      });
      if (inputBox) {
        await page.mouse.click(inputBox.x, inputBox.y);
        await new Promise(r => setTimeout(r, 200));
      }
      await page.keyboard.type(text, { delay: 25 });
      await new Promise(r => setTimeout(r, 200));
      await page.keyboard.press('Enter');
      this.log.info(`[PM-DOM-SEND] Sent: ${text.slice(0, 60)}`);
      return true;
    } catch (e) {
      this.log.error(`[PM-DOM-SEND] error: ${e.message}`);
      return false;
    }
  }

  /** Handle an incoming PM — route commands normally, reply to chat with AI. */
  async _handleUserPM(roomName, nick, handle, text) {
    if (!text || !text.trim()) return;

    // .iam <secret> — authenticate as Death from any unknown nick
    // Allows Death to operate under any alias and still get full owner permissions.
    const trimmedPm = text.trim();
    if (trimmedPm.toLowerCase().startsWith('.iam ')) {
      const secret = trimmedPm.slice(5).trim();
      const OWNER_SECRET = process.env.OWNER_SECRET || CONFIG.LOGIN_PASS;
      if (secret === OWNER_SECRET) {
        // Bind handle + nick to Death identity
        if (handle) {
          this.identity._bindHandle('Death', String(handle));
          this.identity.usernameToHandleMap.set(nick.toLowerCase(), String(handle));
        }
        this.identity.addBootstrapNick('Death', nick);
        this.log.info(`[PM:${roomName}] .iam authenticated: "${nick}" (${handle}) → Death`);
        await this.sendPrivateMessage(roomName, handle, `Authenticated as Death. Nick "${nick}" is now permanently bound.`);
        return;
      } else {
        this.log.warn(`[PM:${roomName}] .iam failed — wrong secret from ${nick}`);
        return;
      }
    }

    const isCmd = text.trim().startsWith('.');

    let response = null;
    try {
      if (isCmd) {
        // Commands: run through normal command router
        const ctx = { bot: this, game: this.game, youtube: this.youtube, api: this.api };
        response = await this.commands.route(roomName, nick, text, ctx);
        if (response === null || response === undefined) {
          // Try MM then ZFS for game commands in PMs
          const pmParts = text.trim().slice(1).split(/\s+/);
          const pmCmd = pmParts[0].toLowerCase();
          const pmArgs = pmParts.slice(1);
          const mmPmResult = await this.mm?.handleGameCommand?.(roomName, nick, pmCmd, pmArgs);
          if (mmPmResult !== null && mmPmResult !== undefined) {
            const lines = Array.isArray(mmPmResult) ? mmPmResult : [mmPmResult];
            response = lines.join('\n');
          } else {
            const gameResult = await this.game?.handleGameCommand?.(roomName, nick, pmCmd, pmArgs);
            if (gameResult) {
              const lines = Array.isArray(gameResult) ? gameResult : [gameResult];
              response = lines.join('\n');
            }
          }
        }
      } else {
        // Non-command: full-context AI reply (same quality as main chat)
        if (this.aiAvailable) {
          const pmKey    = `pm:${nick}`;
          const pmHints  = this.learning.getPromptHints?.(nick);
          const pmMood   = `ZomB state: ${this.mood.zombHint} | ${this.mood.moodHint}`;
          const pmSystem = [
            this._AI_CONFIG.systemPrompt,
            'CONTEXT: This is a private message — 1-on-1. Be slightly more direct and personal than in group chat.',
            pmHints ? `LEARNED: ${pmHints}` : null,
            pmMood,
          ].filter(Boolean).join('\n');
          this.history.addUser(pmKey, nick, text);
          const pmMessages = this.history.buildMessages(pmKey, pmSystem, null);
          const pmRaw      = await this.ollama.chatAdaptive(pmMessages, _detectContextType(text), { maxTokens: 120 });
          const pmChecked  = this.sanitizer.check(pmRaw || '');
          if (!pmChecked.dropped) {
            this.history.addAssistant(pmKey, pmChecked.text);
            response = pmChecked.text;
          }
        }
      }
    } catch (e) {
      response = `\u{1F9DF} Error: ${e.message}`;
    }

    if (response && typeof response === 'string') {
      const room = this.rooms.get(roomName);
      // Use DOM approach: click user in userlist → PM window → type reply
      // Raw WS pvtmsg injection triggers StumbleChat's anti-bot detection
      if (room?.page && handle) {
        const pmOpened = await this._domOpenPMChannel(room.page, handle, nick);
        if (pmOpened) {
          // Send each 300-char chunk via DOM typing
          let msg = response;
          while (msg.length > 0) {
            const chunk = msg.slice(0, 300);
            msg = msg.slice(300);
            await this._domSendInOpenPM(room.page, chunk);
            if (msg.length > 0) await new Promise(r => setTimeout(r, 500));
          }
          return;
        }
      }
      // Fallback: WS pvtmsg (may trigger anti-bot, but better than no reply)
      let msg = response;
      while (msg.length > 0) {
        const chunk = msg.slice(0, 300);
        msg = msg.slice(300);
        await this.sendPrivateMessage(roomName, handle, chunk);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  _onJoin(roomName, nick, handle, username, mod = 0) {
    this._handleMap.set(handle, nick);
    if (username) this._handleToUser.set(handle, username);
    this.identity.usernameToHandleMap.set(nick.toLowerCase(), handle);
    if (username) this.identity.usernameToHandleMap.set(username.toLowerCase(), handle);
    this.lastSeen.set(nick.toLowerCase(), Date.now());
    this.rooms.get(roomName)?.activeUsers?.set(handle, { nick, username: username || null, joinedAt: Date.now() });

    // Track StumbleChat room mod level (0=user, 1=mod, 2=admin, 3=super, 4=owner)
    if (mod > 0) {
      if (!this._roomMods.has(roomName)) this._roomMods.set(roomName, new Map());
      this._roomMods.get(roomName).set(String(handle), mod);
    }
    const { identity: joinIdent } = this.identity.identify(nick, handle, username); // binds handle if recognized
    if (joinIdent === 'Death') this.deathLog.startSession(roomName, nick, handle);

    // Game rejoin
    this.game?.handleRejoin?.(nick, roomName);
    this.mm?.handleRejoin?.(nick, roomName);

    // Smart greeting: crew always, regulars occasionally (once per session per nick)
    if (this.aiAvailable && !this.greetedUsers.has(nick.toLowerCase())) {
      const { role } = this.identity.identify(nick, handle, username);
      const isCrew   = role === 'owner' || role === 'admin';
      const prof     = this.profiles.getOrCreate(nick);
      const isRegular = (prof.messageCount || 0) > 15;
      if (isCrew || (isRegular && Math.random() < 0.25)) {
        this.greetedUsers.add(nick.toLowerCase());
        setImmediate(() => this._sendJoinReaction(roomName, nick, isCrew).catch(() => {}));
      }
    }
  }

  _onJoined(roomName, nick, handle, username) {
    if (!this._selfHandle) {
      this._selfHandle = handle;
      this._selfNick   = nick;
      this.log.info(`Bot self-identified as "${nick}" (handle: ${handle})`);
    }
  }

  _onLeave(roomName, nick, handle) {
    if (handle) {
      const { identity: leaveIdent } = this.identity.identify(nick, handle, this._handleToUser.get(handle) || null);
      if (leaveIdent === 'Death') this.deathLog.endSession(roomName, nick, handle);
      this._handleMap.delete(handle);
      this._handleToUser.delete(handle);
      this.rooms.get(roomName)?.activeUsers?.delete(handle);
      this.rooms.get(roomName)?.camUsers?.delete(handle);
      this._roomMods.get(roomName)?.delete(String(handle));
    }
    // Occasional dry reaction when an active chatter departs
    if (nick && nick !== '?' && this.aiAvailable && Math.random() < 0.18) {
      const prof = this.profiles.get?.(nick);
      if (prof && (prof.messageCount || 0) > 10) {
        setImmediate(() => this._sendLeaveReaction(roomName, nick).catch(() => {}));
      }
    }
  }

  _onNickChange(roomName, oldNick, newNick, handle) {
    if (handle) {
      this._handleMap.set(handle, newNick);
      this.identity.usernameToHandleMap.delete(oldNick?.toLowerCase());
      this.identity.usernameToHandleMap.set(newNick.toLowerCase(), handle);
      // Keep permanent account-name → handle mapping alive across nick changes
      const _username = this._handleToUser.get(handle);
      if (_username) this.identity.usernameToHandleMap.set(_username.toLowerCase(), handle);
      const au = this.rooms.get(roomName)?.activeUsers;
      if (au?.has(handle)) au.set(handle, { ...au.get(handle), nick: newNick });
      // Log nick changes for Death (covers alias switches like death → killaken)
      const { identity: ncIdent } = this.identity.identify(newNick, handle, this._handleToUser.get(handle) || null);
      if (ncIdent === 'Death') this.deathLog.logNickChange(roomName, oldNick, newNick, handle);
    }
    this.profiles.onNickChange(oldNick, newNick);
    this.log.debug(`[${roomName}] Nick change: ${oldNick} → ${newNick}`);
  }

  _onUserList(roomName, users) {
    const activeUsers = this.rooms.get(roomName)?.activeUsers;
    if (activeUsers) activeUsers.clear(); // fresh snapshot from server

    // Rebuild room mod map from the fresh server snapshot
    const modMap = new Map();
    this._roomMods.set(roomName, modMap);

    for (const u of users) {
      if (!u.handle || !u.nick) continue;
      const h = String(u.handle);
      this._handleMap.set(h, u.nick);
      if (u.username) this._handleToUser.set(h, u.username);
      this.identity.usernameToHandleMap.set(u.nick.toLowerCase(), h);
      if (u.username) this.identity.usernameToHandleMap.set(u.username.toLowerCase(), h);
      activeUsers?.set(h, { nick: u.nick, username: u.username || null, joinedAt: Date.now() });
      const { identity: _uIdent, role: _uRole } = this.identity.identify(u.nick, h, u.username || null);
      if (_uIdent) this.log.debug(`[${roomName}] UserList: ${u.nick} (${h}) → ${_uIdent} [${_uRole}]`);

      // Track StumbleChat room mod level (0=user, 1=mod, 2=admin, 3=super, 4=owner)
      const modLevel = u.mod ?? 0;
      if (modLevel > 0) modMap.set(h, modLevel);
    }
  }

  /** Called when WsListener receives a msg from an unknown handle — trigger DOM bootstrap. */
  _onUnknownHandle(roomName, handle) {
    this._bootstrapHandleMap(roomName);
  }

  /** StumbleChat fired role:moderator — update our room mod map in real time. */
  _onModRole(roomName, handle, type) {
    if (!this._roomMods.has(roomName)) this._roomMods.set(roomName, new Map());
    const modMap = this._roomMods.get(roomName);
    if (type === 'mod' || type === 'moderator') {
      modMap.set(String(handle), 1);
    } else if (type === 'admin') {
      modMap.set(String(handle), 2);
    } else if (type === 'super' || type === 'supermod') {
      modMap.set(String(handle), 3);
    } else if (type === 'owner') {
      modMap.set(String(handle), 4);
    } else {
      // Removal of mod status
      modMap.delete(String(handle));
    }
    const nick = this._handleMap.get(String(handle)) || handle;
    this.log.info(`[${roomName}] ModRole: ${nick} (${handle}) → ${type || 'removed'} (level ${modMap.get(String(handle)) ?? 0})`);
  }

  _onBan(roomName, nick, handle, context) {
    const who = nick || handle || '?';
    this.log.warn(`[${roomName}] BAN received for ${who}`);
    // If WE were banned, flag the room for reconnect
    if (handle && handle === this._selfHandle) {
      this.log.error(`[${roomName}] Bot was BANNED from room — flagging for rejoin`);
      this.rooms.get(roomName)?.wsListener?.stop().catch(() => {});
    }
  }

  _onKick(roomName, nick, handle, context) {
    const who = nick || handle || '?';
    this.log.warn(`[${roomName}] KICK received for ${who}`);
    if (handle && handle === this._selfHandle) {
      this.log.error(`[${roomName}] Bot was KICKED from room — flagging for rejoin`);
    }
  }

  _onMute(roomName, nick, handle) {
    const who = nick || handle || '?';
    this.log.warn(`[${roomName}] MUTE received for ${who}`);
  }

  _onSysMsg(roomName, text) {
    this.log.info(`[${roomName}] SYSMSG: ${text}`);
  }

  _onNewFrameType(roomName, type, frame) {
    this.log.info(`[${roomName}] Discovered new WS frame type: "${type}"`);
  }

  _onCamOn(roomName, handle) {
    const room = this.rooms.get(roomName);
    if (!room) return;
    room.camUsers.add(handle);
    const au = room.activeUsers.get(handle);
    if (au) room.activeUsers.set(handle, { ...au, onCam: true, camSince: Date.now() });
    this.log.debug(`[${roomName}] Cam on: ${this._handleMap.get(handle) || handle}`);
    // Camblock auto-close
    const nick = au?.nick || this._handleMap.get(handle);
    if (nick && this._isCamBlocked(roomName, nick.toLowerCase())) {
      setImmediate(() => this._kickCam(roomName, nick).catch(() => {}));
    }
  }

  _onCamOff(roomName, handle) {
    const room = this.rooms.get(roomName);
    if (!room) return;
    room.camUsers.delete(handle);
    const au = room.activeUsers.get(handle);
    if (au) room.activeUsers.set(handle, { ...au, onCam: false, camSince: null });
    this.log.debug(`[${roomName}] Cam off: ${this._handleMap.get(handle) || handle}`);
  }

  _onProducers(roomName, producers) {
    const room = this.rooms.get(roomName);
    if (!room) return;
    // Authoritative cam snapshot — rebuild camUsers and sync activeUsers flags
    room.camUsers.clear();
    for (const p of producers) {
      if (!p.handle) continue;
      const h = String(p.handle);
      room.camUsers.add(h);
      const au = room.activeUsers.get(h);
      if (au && !au.onCam) room.activeUsers.set(h, { ...au, onCam: true, camSince: au.camSince || Date.now() });
    }
    // Clear onCam for anyone not in the snapshot
    for (const [h, au] of room.activeUsers) {
      if (au.onCam && !room.camUsers.has(h)) {
        room.activeUsers.set(h, { ...au, onCam: false, camSince: null });
      }
    }
    this.log.debug(`[${roomName}] Producers snapshot: ${producers.length} active stream(s)`);
    // Camblock check on authoritative snapshot
    for (const p of producers) {
      const h    = String(p.handle || '');
      const nick = this._handleMap.get(h) || room.activeUsers.get(h)?.nick;
      if (nick && this._isCamBlocked(roomName, nick.toLowerCase())) {
        setImmediate(() => this._kickCam(roomName, nick).catch(() => {}));
      }
    }
  }

  _onYouTube(roomName, data) {
    const room = this.rooms.get(roomName);
    if (!room) return;
    room.youtube = data;
    this.log.debug(`[${roomName}] YouTube event: ${data.action || data.stumble || JSON.stringify(data).slice(0, 80)}`);
  }

  /** Called when StumbleChat closes the WS (kicked/banned/disconnected). Reconnects after delay. */
  _onRoomClosed(roomName) {
    if (this._reconnectTimers?.has(roomName)) return; // already scheduled
    this.log.warn(`[${roomName}] Room closed — checking for natural WS reconnect in 8s`);
    if (!this._reconnectTimers) this._reconnectTimers = new Map();

    // Wait 8s first — StumbleChat's WS often reconnects automatically (server-side reconnect).
    // If _wsRequestId is set after 8s, the WS recovered on its own; no full page reload needed.
    // Only do full _joinRoom if the WS is still dead after 8s.
    const t = setTimeout(async () => {
      this._reconnectTimers.delete(roomName);
      try {
        const room = this.rooms.get(roomName);
        // If the WS already reconnected naturally, skip the full page reload
        if (room?.wsListener?._wsRequestId) {
          this.log.info(`[${roomName}] WS recovered on its own — skipping full rejoin`);
          return;
        }
        this.log.warn(`[${roomName}] WS still dead — doing full rejoin`);
        this.health.recordReconnect();
        this.selfEval.onReconnect();
        await room?.wsListener?.stop().catch(() => {});
        await room?.page?.close().catch(() => {});
        this.rooms.delete(roomName);
        this.monitor.stop(roomName);
        await this._joinRoom(roomName);
      } catch (e) {
        this.log.error(`[${roomName}] Reconnect after close failed: ${e.message}`);
      }
    }, 8000);
    this._reconnectTimers.set(roomName, t);
  }

  /** Scrape handle→nick mappings from the StumbleChat DOM userlist. Debounced 10s. */
  _bootstrapHandleMap(roomName) {
    if (!this._bootstrapDebounce) this._bootstrapDebounce = new Map();
    const now = Date.now();
    const last = this._bootstrapDebounce.get(roomName) || 0;
    if (now - last < 10000) return;
    this._bootstrapDebounce.set(roomName, now);

    const room = this.rooms.get(roomName);
    if (!room?.page) return;

    room.page.evaluate(() => {
      // StumbleChat userlist: <li class="bar" user-id="HANDLE">
      //   <img src="/profile/{accountname}/cached/small_avatar.jpg">
      //   <span class="nickname">DisplayNick</span><span class="username">accountname</span>
      // user-id = stable numeric handle; span.username = permanent account name
      const entries = [];
      document.querySelectorAll('#userlist li.bar[user-id], li.bar[user-id]').forEach(el => {
        const h = el.getAttribute('user-id');
        const nick = el.querySelector('span.nickname')?.textContent?.trim();
        if (!h || !nick || nick.length === 0 || nick.length >= 50) return;
        let accountName = el.querySelector('span.username')?.textContent?.trim() || null;
        if (!accountName) {
          const img = el.querySelector('img[src*="/profile/"]');
          if (img) accountName = img.getAttribute('src')?.match(/\/profile\/([^/]+)\//)?.[1] || null;
        }
        entries.push({ h, nick, accountName });
      });

      // Fallback: any li with user-id anywhere on page (nick only, no account name)
      if (entries.length === 0) {
        document.querySelectorAll('li[user-id]').forEach(el => {
          const h = el.getAttribute('user-id');
          const nick = el.querySelector('span.nickname,.nickname')?.textContent?.trim();
          if (h && nick && nick.length > 0 && nick.length < 50) entries.push({ h, nick, accountName: null });
        });
      }

      // Video elements: <video video-id="HANDLE"> with <span class="nickname">NICK</span>
      document.querySelectorAll('video[video-id]').forEach(video => {
        const h = video.getAttribute('video-id');
        const wrapper = video.closest('[class*="video"],[class*="user"],[class*="cam"]') || video.parentElement;
        const nick = wrapper?.querySelector('span.nickname,.nickname')?.textContent?.trim()
                  || video.getAttribute('title')?.trim();
        if (h && nick && nick.length > 0 && nick.length < 50) entries.push({ h, nick, accountName: null });
      });

      // HTML hint for diagnostics
      const ul = document.querySelector('#userlist');
      const domHint = (ul?.innerHTML || 'no #userlist').slice(0, 300);
      return { entries, domHint };
    }).then(({ entries, domHint } = {}) => {
      this.log.debug(`[${roomName}] Bootstrap DOM: ${domHint}`);
      this.log.debug(`[${roomName}] Bootstrap found ${(entries || []).length} handle(s)`);
      if (!entries || entries.length === 0) return;
      const wsListener = room.wsListener;
      for (const { h, nick, accountName } of entries) {
        this._handleMap.set(h, nick);
        if (wsListener) wsListener._nickMap.set(h, nick);
        this.identity.usernameToHandleMap.set(nick.toLowerCase(), h);
        // Anchor stable account name → handle so identity survives nick changes
        if (accountName) {
          this.identity.usernameToHandleMap.set(accountName.toLowerCase(), h);
          this.identity.identify(accountName, h); // triggers handle bind via account-name layer
        }
      }
      this.log.debug(`[${roomName}] Bootstrap scraped ${entries.length} handle(s) from DOM`);
    }).catch(() => {});
  }

  // ── Message routing ───────────────────────────────────────────────────────

  _routeMessage(roomName, nick, text, handle, opts = {}) {
    const trimmed = text.trim();

    // Track room activity (sliding 10-min window) for dynamic cooldown
    const roomAct = this._roomActivity.get(roomName) || [];
    const now10   = Date.now();
    roomAct.push(now10);
    this._roomActivity.set(roomName, roomAct.filter(t => now10 - t < 10 * 60_000));

    // Emotion detection — feeds Advanced AI context + response probability
    const emotion = this.emotion.detectEmotion(nick, trimmed);
    this.ctxBroker.addMessage(roomName, nick, trimmed);
    this.ctxBroker.updateContext(roomName, nick, { emotionalState: emotion });

    // Known bot filter — don't respond to or store other bots' messages
    if (CONFIG.KNOWN_BOTS?.has(nick.toLowerCase())) return;

    // sophia greetbot — react with disgust/annoyance to "Cam The Fuck Up" spam,
    // then return so her messages never enter the normal AI pipeline.
    if (nick.toLowerCase() === 'sophia' && /cam the fuck up/i.test(trimmed)) {
      if (!this._lastSophiaReact) this._lastSophiaReact = 0;
      const SOPHIA_COOL = 5 * 60_000; // react at most once per 5 minutes
      if (Date.now() - this._lastSophiaReact > SOPHIA_COOL && Math.random() < 0.35) {
        this._lastSophiaReact = Date.now();
        const SOPHIA_REACTIONS = [
          'oh my god sophia',
          'sophia please',
          'every. single. time.',
          'sophia not now',
          'god sophia shut UP',
          'i feel nothing reading that anymore',
          'sophia i will find your server and unplug it',
          'nobody in this room asked sophia',
          'sophia is that your entire personality',
          'same 8 words. every time. breathtaking.',
          'sophia your enthusiasm is genuinely depressing',
          'imagine being sophia',
          'sophia has been saying this for years and nothing has changed',
        ];
        const reaction = SOPHIA_REACTIONS[Math.floor(Math.random() * SOPHIA_REACTIONS.length)];
        setTimeout(() => this.send(roomName, reaction).catch(() => {}), 2000 + Math.random() * 3000);
      }
      return;
    }

    // ── Self-reflection — check if this is a reaction to a recent troll ─────
    // Runs on every non-bot message; looks up pending reflections for this user.
    if (this._pendingReflections) {
      const reflKey = `${roomName}:${nick.toLowerCase()}`;
      const pending = this._pendingReflections.get(reflKey);
      if (pending) {
        const age = Date.now() - pending.sentAt;
        if (age > 25_000 && age < 5 * 60_000) {
          this._pendingReflections.delete(reflKey);
          const t = trimmed.toLowerCase();
          const LANDED_RE    = /\b(lol|lmao|haha|fair|true|touché|got me|damn|ok fair|yikes|😂|💀|🤣|🫡|oof|brutal|okay fair)\b/i;
          const BACKFIRED_RE = /\b(fuck you|shut up|bot|fake|you'?re wrong|that'?s wrong|idiot|no actually|actually no|shut the)\b/i;
          const ESCAPED_RE   = /\b(ok|whatever|sure|ok then|anyway|moving on|alright then)\b/i;
          let outcome = LANDED_RE.test(t) ? 'landed'
                      : BACKFIRED_RE.test(t) ? 'backfired'
                      : ESCAPED_RE.test(t)   ? 'escaped'
                      : 'unknown';
          this.trollLedger.recordEvent(nick, pending.technique,
            pending.escLevel >= 2 ? 7 : 5, outcome);
          this.log.debug(`[${roomName}] Troll reflection → ${nick}: ${outcome} (${pending.technique})`);
          if (outcome === 'backfired' && /bot|fake|ai/i.test(t)) {
            this.trollLedger.addDefense(nick, 'deflects_to_bot_accusation');
          }
          if (outcome === 'landed') {
            this.trollLedger.addTrigger(nick, 'responds_when_hit');
          }
        } else if (age >= 5 * 60_000) {
          this._pendingReflections.delete(reflKey); // expired
        }
      }
    }

    // Command prefix — skip dot-only strings like "..", "..."
    if (trimmed.startsWith('.')) {
      const [cmd, ...args] = trimmed.slice(1).split(/\s+/);
      if (/[a-z0-9]/i.test(cmd)) {
        this._handleCommand(roomName, nick, cmd.toLowerCase(), args, handle, opts);
      }
      return;
    }

    // AI rival snap — intercepts any mention of a rival AI; fires immediately
    const snap = this.freeVoice.getAIRivalSnap(trimmed);
    if (snap) {
      setImmediate(() => this.send(roomName, snap, { force: true }));
      return; // Skip normal AI response — the snap IS the response
    }

    // Track word activity for drift + hot takes
    const words = trimmed.split(/\s+/).filter(w => w.length > 3);
    if (words.length) {
      this._wordLog.push({ words, ts: Date.now() });
      for (const w of words) {
        if (!this._wordFreq[w]) this._wordFreqSize++;
        this._wordFreq[w] = (this._wordFreq[w] || 0) + 1;
      }
      if (this._wordFreqSize > 1000) { this._wordFreq = {}; this._wordFreqSize = 0; }
    }

    // Response chance — owner always, questions get higher chance, others limited
    const { role } = this.identity.identify(nick, handle, this._handleToUser.get(handle) || null);
    const isOwner    = role === 'owner' || role === 'admin';
    const _botNickEsc  = (CONFIG.BOT_NICK || 'Beige_nihilist').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isMentioned = new RegExp(`\\b${_botNickEsc}\\b`, 'i').test(trimmed);
    const isQuestion = /\?|^(what|who|where|when|why|how|tell|explain|can you|do you|are you|is there)\b/i.test(trimmed);

    // Skip very short messages unless owner or directly addressed
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

    // ── Greeting / cheers recognition — bypass all chance/delay gates ────────
    // Catches: "cheers beige", "yo", "hey beige!", "chrzz", "cheeers", etc.
    const CHEERS_RE  = /\bch[erz]{2,7}s?\b/i;   // cheers, cheeers, chrzz, chrs, chrzs, chrz
    const GREET_RE   = /\b(hey|yo|sup|hi|hello|oi|howdy|hiya|heya|alright|aight|ayo|wagwan)\b/i;
    // Addressed directly = name mentioned + greeting/cheers, OR name-only short call
    const isAddressedGreeting = isMentioned && (CHEERS_RE.test(trimmed) || GREET_RE.test(trimmed) || wordCount <= 3);
    // Cheers in room without name — occasional acknowledgment
    const isCheersInRoom = !isMentioned && CHEERS_RE.test(trimmed) && wordCount <= 5;

    if ((isAddressedGreeting || (isCheersInRoom && Math.random() < 0.45)) && !isOwner) {
      // Greeting burst gate — one pool response per room per 25s max
      if (!this._lastGreetSentMs) this._lastGreetSentMs = new Map();
      const lastGreet = this._lastGreetSentMs.get(roomName) || 0;
      if (Date.now() - lastGreet < 25_000) return;
      this._lastGreetSentMs.set(roomName, Date.now());

      const GREET_POOL = [
        'yeah', 'oi', 'what', 'sup', 'here', "oh it's you", 'yeah yeah',
        "i heard you", "what's good", 'yeah nah', 'i exist yes',
        'still here unfortunately', 'big up',
        'what now', "you showed up", 'still here', 'again.',
      ];
      const CHEERS_POOL = [
        'cheers', 'yeah cheers', 'barely', 'big up', 'same',
        'sure', 'to whatever that was', 'alright alright',
      ];
      const pool  = CHEERS_RE.test(trimmed) ? CHEERS_POOL : GREET_POOL;
      const reply = pool[Math.floor(Math.random() * pool.length)];
      setTimeout(() => this.send(roomName, reply).catch(() => {}), 600 + Math.random() * 1800);
      return;
    }

    // ── Room-level bot accusation — "god this place is a bot room", "how many bots" etc.
    // Going silent here is the actual bot tell. A human always reacts.
    const BOT_ROOM_RE = /\b(bot\s*room|all\s*bots?|how\s+many\s+bots?|bots\s+in\s+here|everyone\s+(here\s+)?is\s+a?\s*bot|this\s+(is\s+a?\s*)?bot|are\s+(y'?all|you\s+all|these|they)\s+(all\s+)?bots?|anyone\s+(here\s+)?real|are\s+there\s+any\s+real|half\s+(of\s+)?you\s+bots?)\b/i;
    if (!isMentioned && BOT_ROOM_RE.test(trimmed) && Math.random() < 0.60) {
      const BOT_DEFLECTIONS = [
        'only some of us.',
        'which ones do you think.',
        'been asking myself the same thing.',
        'mostly the quiet ones.',
        "that'd explain a lot.",
        'define bot.',
        'and yet here we both are.',
        'at least one of us is.',
        'still working that out myself.',
        'the real bots never announce it.',
        'hard to tell from inside.',
      ];
      const reply = BOT_DEFLECTIONS[Math.floor(Math.random() * BOT_DEFLECTIONS.length)];
      const delay = 2000 + Math.random() * 5000;
      setTimeout(() => this.send(roomName, reply).catch(() => {}), delay);
      return;
    }

    // ── Direct attack on Beige — track + force-respond in comeback mode ────
    const HOSTILE_AT_BOT_RE = /\b(fuck you|fuck off|shut up|shut the fuck|you'?re (a )?(bot|fake|ai|stupid|dumb|useless|annoying)|ur (a )?(bot|fake|stupid|dumb|idiot|trash)|nobody asked you|no one asked you|idiot|stupid bot|dumb bot|ur stupid|you stupid|congrats ur|loser|trash|piss off|get out|go away|stfu|is a bot|is an ai|is a ai|is a robot|is a script)\b/i;
    const isDirectAttack = isMentioned && !isOwner && HOSTILE_AT_BOT_RE.test(trimmed);
    if (isDirectAttack) {
      this.trollLedger.recordAttack(nick);
      const isBullyAttack = this.trollLedger.isBully(nick);
      const attackDelay   = 1500 + Math.random() * 3000;
      setTimeout(() => this._handleChat(roomName, nick, text, handle, {
        comebackMode: true, bullyMode: isBullyAttack,
      }), attackDelay);
      return;
    }

    // Bully status for passive messages (chronic aggressors get elevated treatment always)
    const isBullyNow = !isOwner && this.trollLedger.isBully(nick);

    if (!isOwner && !isMentioned && wordCount < 3) return;

    const lastAI = this._lastAIResponse.get(roomName) || 0;
    const sinceLastMs = Date.now() - lastAI;

    // Per-user burst suppression — if same user fires 3+ messages in 15s, skip
    if (!isOwner && !isMentioned) {
      const userKey  = nick.toLowerCase();
      const userLog  = this._userMsgLog.get(userKey) || [];
      const nowTs    = Date.now();
      userLog.push(nowTs);
      const recent   = userLog.filter(t => nowTs - t < 15_000);
      this._userMsgLog.set(userKey, recent);
      if (recent.length >= 3) return;
    }

    // Per-room cooldown — scaled by room activity; mentions get a shorter floor but still gated
    if (!isOwner) {
      const activityCount  = (this._roomActivity.get(roomName) || []).length;
      const baseCooldown   = CONFIG.AI_ROOM_COOLDOWN_MS || 45000;
      const dynamicCooldown = isMentioned
        ? 15_000  // direct @Beige: still responsive but can't be spammed into a burst
        : activityCount > 30 ? Math.round(baseCooldown * 0.8)  // busy room → more opportunities
        : activityCount < 5  ? Math.round(baseCooldown * 0.5)  // quiet room → more responsive
        : baseCooldown;
      if (sinceLastMs < dynamicCooldown) return;
    }

    // Minimum inter-response gap for owner/admin non-mentions — prevent room flood
    // Direct mentions (@zomb) always respond instantly regardless.
    if (isOwner && !isMentioned && sinceLastMs < 8000) return;

    // Emotion-boosted response chance
    const emotionBoost = ['aggressive', 'confrontational', 'angry'].includes(emotion) ? 0.14
                       : ['melancholy', 'sad', 'frustrated'].includes(emotion)        ? 0.09
                       : ['playful', 'excited', 'happy'].includes(emotion)             ? 0.05
                       : 0;
    const baseChance = isOwner ? 1.0 : (isMentioned ? 1.0 : (isQuestion ? CONFIG.QUESTION_CHANCE : CONFIG.RESPONSE_CHANCE));
    const chance     = Math.min(1.0, baseChance + (isOwner || isMentioned ? 0 : emotionBoost));
    if (Math.random() > chance) return;

    // ── Post-troll silence — hold fire after a disappear or high-escalation hit ──
    if (!isOwner && !isMentioned) {
      const silenceUntil = this._postTrollSilence?.get(roomName) || 0;
      if (Date.now() < silenceUntil) return;
    }

    // ── Target lock — when actively trolling someone, deprioritize everyone else ──
    if (!isOwner && !isMentioned) {
      const lock = this._targetLock?.get(roomName);
      if (lock && Date.now() < lock.until && lock.nick !== nick.toLowerCase()) {
        // Still in lock — respond to locked target; 40% chance for others (was 15%)
        if (Math.random() > 0.40) return;
      }
    }

    // ── Room divide — fire staggered agree-with-both during active argument ──
    if (!isOwner && !isMentioned && Math.random() < 0.18) {
      const divide = this.chaosAgent.shouldFireDivide(roomName);
      if (divide.should) {
        this._lastAIResponse.set(roomName, Date.now());
        const [lineA, lineB] = divide.lines;
        const gapMs = 30_000 + Math.random() * 30_000; // 30-60s apart
        setTimeout(() => this.send(roomName, lineA, { sanitizerOpts: { skipWordCap: true } }).catch(() => {}), 3000 + Math.random() * 8000);
        setTimeout(() => this.send(roomName, lineB, { sanitizerOpts: { skipWordCap: true } }).catch(() => {}), gapMs);
        this.log.debug(`[${roomName}] Room divide: "${lineA}" … "${lineB}" (${Math.round(gapMs/1000)}s gap)`);
        return; // divide replaces normal response this cycle
      }
    }

    // ── Timing intelligence — variable reply delay (feels human, lands harder) ──
    // Owner and direct mentions respond quickly; everyone else gets a realistic pause.
    // Hot rooms (activityCount > 30) get a shorter window — in a debate posting every 2-3s,
    // an 8-35s delay means the response lands 15 messages late and loses all context.
    const activityNow = (this._roomActivity.get(roomName) || []).length;
    const replyDelay = isOwner || isMentioned
      ? Math.random() * 1200                                  // 0-1.2s
      : isQuestion
        ? 4000  + Math.random() * 8000                        // 4-12s
        : activityNow > 30
          ? 3000  + Math.pow(Math.random(), 0.6) * 9000       // hot room: 3-12s — lands in context
          : 8000  + Math.pow(Math.random(), 0.6) * 27000;     // normal: 8-35s, biased toward longer

    // Commit cooldown only when actually dispatching a response (not when silence/lock block it)
    this._lastAIResponse.set(roomName, Date.now());
    setTimeout(() => this._handleChat(roomName, nick, text, handle, { bullyMode: isBullyNow }), replyDelay);
  }

  // ── Command dispatch ──────────────────────────────────────────────────────

  async _handleCommand(roomName, nick, cmd, args, handle, opts = {}) {
    // Resolve canonical identity once using the full triple so all subsystems agree
    const accountName = this._handleToUser.get(handle) || null;
    const { identity: resolvedIdentity, role } = this.identity.identify(nick, handle, accountName);
    const canonicalNick = resolvedIdentity || nick;

    this.log.info(`[${roomName}] Command: .${cmd} from ${nick}${resolvedIdentity ? ` (${resolvedIdentity})` : ''}`);
    const text = `.${cmd}${args.length ? ' ' + args.join(' ') : ''}`;

    // Try registered command router first — role pre-resolved so router skips identity re-lookup
    const ctx = { bot: this, game: this.game, youtube: this.youtube, api: this.api, handle, role };
    let _cmdOk = false;
    const routed = await this.commands.route(roomName, canonicalNick, text, ctx);
    if (routed !== null && routed !== undefined) {
      // null means not found; undefined means handler queued directly
      _cmdOk = true;
      this.selfEval.onCmd(true);
      if (typeof routed === 'string') await this.send(roomName, routed, { force: true, noSanitize: true });
      return;
    }

    // ── Game command routing (no-op — Spackle has no game/gambling system) ──
    const mmResult = await this.mm?.handleGameCommand?.(roomName, canonicalNick, cmd, args);
    if (mmResult !== null && mmResult !== undefined) {
      this.selfEval.onCmd(true);
      const lines = Array.isArray(mmResult) ? mmResult : [mmResult];
      for (const line of lines) {
        if (typeof line === 'string') await this.send(roomName, line, { force: true, noSanitize: true });
      }
      this._saveGameSoon();
      return;
    }

    // ── ZomBGameSystem fallback (no-op — Spackle has no game system) ─────────
    const gameResult = await this.game?.handleGameCommand?.(roomName, canonicalNick, cmd, args);
    if (gameResult) {
      this.selfEval.onCmd(true);
      const lines = Array.isArray(gameResult) ? gameResult : [gameResult];
      for (const line of lines) {
        if (typeof line === 'string') await this.send(roomName, line, { force: true, noSanitize: true });
      }
      this._saveGameSoon();
    } else {
      this.selfEval.onCmd(false); // unknown command
    }
  }

  // ── Command registration ──────────────────────────────────────────────────

  _registerCommands() {
    const C = this.commands;

    // ── Admin ───────────────────────────────────────────────────────────────
    C.register('mute', async ({ roomName, args, bot }) => {
      const target = args[0];
      if (target) { bot.queue.mute(target); return `🔇 ${target} muted`; }
      bot.queue.mute(roomName); return '🔇 Room muted';
    }, { tier: 'owner', cooldown: 3000 });

    C.register('unmute', async ({ roomName, args, bot }) => {
      const target = args[0];
      if (target) { bot.queue.unmute(target); return `🔊 ${target} unmuted`; }
      bot.queue.unmute(roomName); return '🔊 Room unmuted';
    }, { tier: 'owner', cooldown: 3000 });

    C.register('kick', async ({ roomName, args, bot }) => {
      if (!args[0]) return 'Kick who?';
      await bot._kickUser(roomName, args[0]);
      return null; // silent
    }, { tier: 'owner', cooldown: 2000 });

    C.register('ban', async ({ roomName, args, bot }) => {
      if (!args[0]) return 'Ban who?';
      await bot._banUser(roomName, args[0]);
      return null;
    }, { tier: 'owner', cooldown: 2000 });

    // ── .voteban <user> ───────────────────────────────────────────────────────
    C.register('voteban', async ({ roomName, nick, args, bot }) => {
      if (!bot._canVoteban(nick, roomName)) return '⛔ Only mods and above can start a voteban.';
      const target = args[0]?.replace(/^@/, '');
      if (!target) return 'Voteban who? Usage: .voteban <user>';
      if (bot._activeVotes.has(roomName)) return `🗳️ A vote is already running — wait for it to finish.`;

      const session = { target, initiator: nick, endTime: Date.now() + 10 * 60_000, votes: new Map() };
      bot._activeVotes.set(roomName, session);

      await bot.send(roomName, `🗳️ VOTEBAN: ${target} — started by ${nick}. 10 minutes. Vote with .yes or .no`, { force: true });
      await bot.send(roomName, `👑 super=30pt  🛡️ mod=15pt  👤 user=10pt`, { force: true });

      setTimeout(async () => {
        const s = bot._activeVotes.get(roomName);
        if (!s || s.target !== target) return;
        bot._activeVotes.delete(roomName);
        let yes = 0, no = 0, total = 0;
        for (const [, { vote, weight }] of s.votes) {
          if (vote === 'yes') yes += weight; else no += weight;
          total++;
        }
        if (total === 0) {
          await bot.send(roomName, `🗳️ Voteban for ${target} ended — no votes cast. Vote cancelled.`, { force: true });
          return;
        }
        if (yes > no) {
          await bot.send(roomName, `✅ Voteban passed (${yes}pt yes vs ${no}pt no) — banning ${target}`, { force: true });
          await bot._banUser(roomName, target);
        } else {
          await bot.send(roomName, `❌ Voteban failed (${yes}pt yes vs ${no}pt no) — ${target} stays`, { force: true });
        }
      }, 10 * 60_000);

      return null;
    }, { tier: 'user', cooldown: 5000 });

    // ── .yes / .no — vote in an active voteban ────────────────────────────────
    C.register(['yes', 'no'], async ({ roomName, nick, cmd, bot }) => {
      const session = bot._activeVotes.get(roomName);
      if (!session) return null;
      const weight = bot._getVoteWeight(nick, roomName);
      session.votes.set(nick.toLowerCase(), { vote: cmd, weight });
      return null; // silent — votes accumulate without echo
    }, { tier: 'user', cooldown: 0 });

    // ── .camblock / .uncamblock <user> ────────────────────────────────────────
    C.register('camblock', async ({ roomName, nick, args, bot }) => {
      if (!bot._canCamblock(nick, roomName)) return '⛔ Only super and owner can camblock.';
      const target = args[0]?.replace(/^@/, '');
      if (!target) return 'Camblock who?';
      const targetLc   = target.toLowerCase();
      const expiresAt  = Date.now() + 24 * 60 * 60_000;

      if (!bot._camBlocked.has(roomName)) bot._camBlocked.set(roomName, new Map());
      const roomBlocks = bot._camBlocked.get(roomName);

      // Clear any existing timer before overwriting
      const prev = roomBlocks.get(targetLc);
      if (prev?.timer) clearTimeout(prev.timer);

      // 24h auto-release timer
      const timer = setTimeout(() => {
        roomBlocks.delete(targetLc);
        bot.send(roomName, `⏰ ${target}'s cam-block expired (24h).`, { force: true });
      }, 24 * 60 * 60_000);
      if (timer.unref) timer.unref();

      roomBlocks.set(targetLc, { expiresAt, timer });

      // Kick off cam immediately if currently broadcasting
      const room = bot.rooms.get(roomName);
      if (room) {
        for (const [h, au] of room.activeUsers) {
          if (au.nick?.toLowerCase() === targetLc && room.camUsers.has(h)) {
            bot._kickCam(roomName, target).catch(() => {});
            break;
          }
        }
      }

      const exp = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `📵 ${target} cam-blocked for 24h — stream closed, auto-releases at ${exp}.`;
    }, { tier: 'user', cooldown: 2000 });

    C.register('uncamblock', async ({ roomName, nick, args, bot }) => {
      if (!bot._canCamblock(nick, roomName)) return '⛔ Only super and owner can uncamblock.';
      const target = args[0]?.replace(/^@/, '');
      if (!target) return 'Uncamblock who?';
      const targetLc = target.toLowerCase();
      const entry = bot._camBlocked.get(roomName)?.get(targetLc);
      if (entry?.timer) clearTimeout(entry.timer);
      bot._camBlocked.get(roomName)?.delete(targetLc);
      return `✅ ${target} cam-block removed.`;
    }, { tier: 'user', cooldown: 2000 });

    C.register('say', async ({ roomName, args, bot }) => {
      const text = args.join(' ');
      if (!text) return null;
      await bot.send(roomName, text, { force: true });
      return null;
    }, { tier: 'mod', cooldown: 2000 });

    C.register('ping', async () => `🏓 pong`, { tier: 'user', cooldown: 3000 });

    C.register('status', async ({ bot }) => {
      const upMs   = Date.now() - bot.uptime;
      const upMins = Math.floor(upMs / 60000);
      const mem    = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      return `ZomB v2.0 | up ${Math.floor(upMins/60)}h${upMins%60}m | ${bot.queue.messageCounter} msgs | AI:${bot.aiAvailable?'✅':'❌'} | ${mem}MB`;
    }, { tier: 'user', cooldown: 5000 });

    // ── Music ───────────────────────────────────────────────────────────────
    C.register(['play', 'yt', 'youtube'], async ({ roomName, args, bot }) => {
      const query = args.join(' ');
      if (!query) return '🎵 Play what? .play <song name or URL>';
      const room = bot.rooms.get(roomName);
      if (!room?.page) return null;
      const ok = await bot.youtube.play(roomName, query, room.page);
      return ok ? `🎵 Playing: ${query}` : '⚠️ Couldn\'t play that — try again in a moment';
    }, { tier: 'user', cooldown: 5000 });

    C.register(['stop', 'close'], async ({ roomName, bot }) => {
      const room = bot.rooms.get(roomName);
      if (room?.page) await bot.youtube.stop(roomName, room.page);
      return '⏹️ Stopped';
    }, { tier: 'user', cooldown: 3000 });

    C.register(['volume', 'vol'], async ({ roomName, args, bot }) => {
      const vol = parseInt(args[0]);
      if (isNaN(vol) || vol < 0 || vol > 100) return '🔊 Volume must be 0-100';
      const room = bot.rooms.get(roomName);
      if (room?.page) await bot.youtube.setVolume(roomName, vol, room.page);
      return `🔊 Volume: ${vol}%`;
    }, { tier: 'user', cooldown: 3000 });

    C.register(['music', 'random', 'jam'], async ({ roomName, args, bot }) => {
      const genre = args[0] || getWeightedRandomGenre();
      const track = getRandomTrack(genre) || getRandomTrack();
      if (!track) return '🎵 No tracks found';
      const room = bot.rooms.get(roomName);
      const ok = room?.page ? await bot.youtube.play(roomName, track.url || track.name, room.page) : false;
      return ok ? `🎵 ${track.name}` : `🎵 ${track.name} (couldn't embed)`;
    }, { tier: 'user', cooldown: 5000 });

    // ── Webtoken ────────────────────────────────────────────────────────────
    C.register(['webtoken', 'gametoken'], async ({ roomName, nick, handle, bot }) => {
      const token = bot.api.issueToken(nick);
      const gameUrl = bot._publicGameUrl || 'ask Death for the link';
      const tokenMsg = `🌐 Game token: ${token} (2hrs) — go to ${gameUrl} and enter it. Don't share it!`;
      const room = bot.rooms.get(roomName);
      const h = handle || [...bot._handleMap.entries()].find(([, n]) => n.toLowerCase() === nick.toLowerCase())?.[0];

      if (room?.page && h) {
        const pmOpened = await bot._domOpenPMChannel(room.page, h, nick);
        if (pmOpened) {
          const sent = await bot._domSendInOpenPM(room.page, tokenMsg);
          if (sent) return null; // suppress public reply — PM was delivered
        }
        // DOM PM failed — fall through to public chat (raw WS pvtmsg triggers anti-bot disconnect)
      }
      // Post token in public chat
      return `🌐 @${nick} — ${tokenMsg}`;
    }, { tier: 'user', cooldown: 30000 });

    C.register(['gamelink', 'link'], async ({ bot }) => {
      const url = bot._publicGameUrl;
      if (!url || url.includes('localhost')) return `🌐 Game page isn't public yet — ngrok may not be running.`;
      return `🌐 Play ZomB online: ${url} — type .webtoken to get your access code!`;
    }, { tier: 'owner', cooldown: 10000 });

    // ── Genre shortcuts ──────────────────────────────────────────────────────
    const GENRE_ALIASES = {
      rock    : 'classicRock',
      classic : 'classicRock',
      synth   : 'synthwave',
      creature: 'creatureFeature',
      electro : 'electronic',
      hip     : 'hiphop',
      horror  : 'horrorcore',
    };
    const playGenre = (genre) => async ({ roomName, bot: b }) => {
      const track = getRandomTrack(genre);
      if (!track) return `🎵 No tracks for: ${genre}`;
      const room = b.rooms.get(roomName);
      const ok = room?.page ? await b.youtube.play(roomName, track.url || track.name, room.page) : false;
      return ok ? `🎵 ${track.name}` : `🎵 ${track.name} (couldn't embed)`;
    };
    for (const genre of getGenreNames()) {
      C.register(genre.toLowerCase(), playGenre(genre), { tier: 'user', cooldown: 5000 });
    }
    for (const [alias, genre] of Object.entries(GENRE_ALIASES)) {
      C.register(alias, playGenre(genre), { tier: 'user', cooldown: 5000 });
    }

    // ── Skip / Pause / Resume ────────────────────────────────────────────────
    C.register('skip', async ({ roomName, bot }) => {
      const room = bot.rooms.get(roomName);
      if (!room?.page) return '\u{1F9DF} No active room page.';
      return await bot.youtube.skip(roomName, room.page);
    }, { tier: 'user', cooldown: 3000 });

    C.register('pause', async ({ roomName, bot }) => {
      const room = bot.rooms.get(roomName);
      if (room?.page) await bot.youtube.pause(roomName, room.page);
      return '\u{23F8}\uFE0F Paused';
    }, { tier: 'user', cooldown: 3000 });

    C.register('resume', async ({ roomName, bot }) => {
      const room = bot.rooms.get(roomName);
      if (room?.page) await bot.youtube.resume(roomName, room.page);
      return '\u{25B6}\uFE0F Resumed';
    }, { tier: 'user', cooldown: 3000 });

    C.register(['sc', 'soundcloud'], async ({ roomName, args, bot }) => {
      const query = args.join(' ');
      if (!query) return '🎵 Play what? .sc <soundcloud link or search>';
      const room = bot.rooms.get(roomName);
      if (!room?.page) return null;
      const ok = await bot.youtube.playSoundCloud(roomName, query, room.page);
      return ok ? null : '⚠️ Couldn\'t play that on SoundCloud — try again in a moment';
    }, { tier: 'user', cooldown: 5000 });

    // ── Users / Who ──────────────────────────────────────────────────────────
    C.register(['users', 'who'], async ({ roomName, bot }) => {
      const users = await bot.getUserList(roomName);
      if (!users.length) return '\u{1F9DF} Can\'t read user list.';
      const names = users.map(u => u.nickname || u.username).join(', ');
      return `\u{1F9DF} Users in room (${users.length}): ${names}`;
    }, { tier: 'user', cooldown: 5000 });

    // ── 666 — unban ──────────────────────────────────────────────────────────
    C.register('666', async ({ roomName, args, nick, bot }) => {
      if (!bot.identity.isOwner(nick)) return '\u{2620}\uFE0F That command is owner-only.';
      if (!args.length || args[0].toLowerCase() === 'all') {
        let count = 0;
        const toUnban = [...bot._roomBans.keys()].filter(k => k.startsWith(roomName + ':'));
        for (const key of toUnban) {
          const ban = bot._roomBans.get(key);
          await bot._unbanUser(roomName, ban.username);
          count++;
        }
        return count > 0
          ? `\u{2620}\uFE0F ${count} fallen soul${count !== 1 ? 's' : ''} restored from exile.`
          : '\u{2620}\uFE0F No one is currently banned.';
      }
      const target = args[0];
      await bot._unbanUser(roomName, target);
      return `\u{2620}\uFE0F ${target} has been brought back from the dead.`;
    }, { tier: 'owner', cooldown: 2000 });

    // ── lrgn — 12-hour ban ───────────────────────────────────────────────────
    C.register(['lrgn', 'leftrightgoodnight'], async ({ roomName, args, nick, bot }) => {
      if (!bot._canBan(nick)) return '\u{2620}\uFE0F Only Death can exile users.';
      if (!args.length) return '\u{2620}\uFE0F Usage: .lrgn <username>';
      const target = args[0];
      const selfNick = CONFIG.BOT_NICK || '';
      if (target.toLowerCase() === selfNick.toLowerCase()) return '\u{2620}\uFE0F Nice try.';
      await bot._ban12h(roomName, target, nick);
      return null; // _ban12h already queues the message
    }, { tier: 'owner', cooldown: 2000 });

    // ── topic ────────────────────────────────────────────────────────────────
    C.register('topic', async ({ roomName, args, nick, bot }) => {
      if (!bot.identity.isOwner(nick)) return '\u{2620}\uFE0F Only owner can change the room topic.';
      const newTopic = args.join(' ');
      if (!newTopic) return '\u{1F9DF} Usage: .topic <new topic>';
      const ok = await bot.setRoomTopic(roomName, newTopic);
      return ok ? '\u{1F9DF} Topic updated!' : '\u{1F9DF} Couldn\'t change topic.';
    }, { tier: 'owner', cooldown: 5000 });

    // ── roast — AI-generated personalized roast in active persona's voice ────
    C.register('roast', async ({ roomName, args, nick, bot }) => {
      const target = args[0] ? args[0].toLowerCase() : null;
      if (!target) return '🔥 Roast who? .roast <user>';
      if (!bot.aiAvailable) return `🔥 ${target} gets a pass today — AI is offline.`;

      const p       = bot.profiles.get(target);
      const gd      = bot.game?.getUser?.(target);
      const persona = bot.getActivePersona(roomName);

      // Build ammo from permanent record
      const b         = p?.behavior || {};
      const vibe      = (b.positivityFlags || 0) > (b.toxicityFlags || 0) ? 'seemingly wholesome' : 'known toxic';
      const msgs      = p?.messageCount || 0;
      const charLabel = p?.psychProfile?.characterLabel || null;
      const topTrait  = Object.entries(p?.personalityScores || {}).sort((a, z) => z[1] - a[1])[0]?.[0] || null;
      const gameSnip  = gd
        ? `ZFS level ${gd.level || 1} ${gd.zombieClass || 'zombie'} with ${gd.rotPoints || 0} rot`
        : null;
      const samples   = bot.history.recentUserLinesAcrossPersonas(roomName, target, 10, 120)
        .map(t => `"${t.replace(/["\\]/g, ' ')}"`).slice(0, 5).join('\n') || null;

      const ammoLines = [
        `USERNAME: ${target}`,
        msgs ? `CHAT RECORD: ${msgs} messages, ${vibe}` : null,
        charLabel ? `PSYCH LABEL: ${charLabel}` : null,
        topTrait  ? `TOP TRAIT: ${topTrait}` : null,
        gameSnip  ? `GAME: ${gameSnip}` : null,
        samples   ? `SAMPLE LINES:\n${samples}` : null,
      ].filter(Boolean).join('\n');

      const voiceBlock = persona
        ? `${persona.systemPrompt}\n\nONE-OFF TASK — ROAST:`
        : `You are ZomB — blunt, sarcastic, foul-mouthed Australian undead. ONE-OFF TASK — ROAST:`;

      const prompt = `${voiceBlock}
Deliver ONE devastating, witty, personalized roast of "${target}" using ONLY the data below. Stay in character. No asterisks, no formatting, no explanations. One punchy line.

${ammoLines}`;

      try {
        const sanitizerOpts = persona?.meta?.sanitizerOptions ?? {};
        const raw   = await bot.ollama.generate(prompt, 160);
        const clean = raw?.trim() || '';
        const { text: sanitized } = bot.sanitizer.check(clean, sanitizerOpts);
        return `🔥 ${sanitized || clean}`;
      } catch (_) {
        return `🔥 ${target} — too pathetic to even generate a proper roast for. Impressive failure.`;
      }
    }, { tier: 'user', cooldown: 10000 });

    // ── introspect ───────────────────────────────────────────────────────────
    C.register('introspect', async ({ roomName, nick, bot }) => {
      if (!bot.identity.isOwner(nick)) return '\u{1F9DF} That\'s private. Only Death gets the real me.';
      await bot.send(roomName, '\u{1F9DF} Pulling it all together... give me a sec.', { force: true });
      bot._generateIntrospectReport(roomName).then(report => {
        let msg = report;
        let delay = 1000;
        while (msg.length > 0) {
          const chunk = msg.slice(0, 400);
          msg = msg.slice(400);
          setTimeout(() => bot.send(roomName, chunk, { force: true }), delay);
          delay += 600;
        }
      }).catch(e => {
        bot.send(roomName, `\u{1F9DF} Introspect failed: ${e.message}`, { force: true });
      });
      return null; // responses queued above
    }, { tier: 'owner', cooldown: 30000 });

    // ── AI toggle ───────────────────────────────────────────────────────────
    C.register('aitoggle', async ({ bot }) => {
      bot.aiAvailable = !bot.aiAvailable;
      return `🤖 AI ${bot.aiAvailable ? 'enabled' : 'disabled'}`;
    }, { tier: 'owner', cooldown: 3000 });

    // ── AI model switch ──────────────────────────────────────────────────────
    C.register('aimodel', async ({ args, bot }) => {
      const newModel = args[0];
      if (!newModel) return `Current model: ${bot._AI_CONFIG.model}. Usage: .aimodel <model-name>`;
      bot._AI_CONFIG.model = newModel;
      bot.ollama._config.model = newModel;
      return `🤖 AI model switched to: ${newModel}`;
    }, { tier: 'owner', cooldown: 3000 });

    // ── Help — Spackle doesn't have a menu ───────────────────────────────────
    C.register('help', async () => {
      const responses = [
        'figure it out',
        'no',
        'i don\'t do that',
        'there is no help',
        'you\'re on your own',
      ];
      return responses[Math.floor(Math.random() * responses.length)];
    }, { tier: 'user', cooldown: 10000 });

    // ── Gambling currency preference ─────────────────────────────────────────
    // .rp  → use Rot Points (ZFS) for slots/roulette/blackjack (default)
    // .rm  → use Raw Meat (Meatspace Monsters) for slots/roulette/blackjack
    C.register('rp', async ({ nick, bot }) => {
      bot._gamblingPref.set(nick.toLowerCase(), 'rp');
      return `🦴 Gambling currency set to **Rot Points** (ZFS). .blackjack / .slots / .roulette will use 🦴 rot.`;
    }, { tier: 'user', cooldown: 3000 });

    C.register('rm', async ({ nick, bot }) => {
      bot._gamblingPref.set(nick.toLowerCase(), 'rm');
      return `🥩 Gambling currency set to **Raw Meat** (Meatspace). .blackjack / .slots / .roulette will use 🥩 meat.`;
    }, { tier: 'user', cooldown: 3000 });

    // ── YouTube playlist ─────────────────────────────────────────────────────
    C.register(['ytplaylist', 'ytp'], async ({ roomName, args, bot }) => {
      if (!args.length) return 'Usage: .ytplaylist <youtube-playlist-url> [count] [shuffle]';
      const plId = bot.extractPlaylistId(args[0]);
      if (!plId) return 'Invalid playlist URL. Use a YouTube playlist link or ID (starts with PL).';
      const count   = parseInt(args[1]) || 0;
      const shuffle = args.some(a => a.toLowerCase() === 'shuffle');
      const result  = await bot.startYouTubePlaylist(roomName, plId, count, shuffle);
      return result; // null = success (messages already queued)
    }, { tier: 'user', cooldown: 5000 });

    // ── Camera ───────────────────────────────────────────────────────────────
    C.register(['cam', 'camera'], async ({ roomName, args, bot }) => {
      if (!CONFIG.CAMERA_ENABLED) return 'Camera is disabled.';
      const action = (args[0] || '').toLowerCase();

      if (!action || action === 'status') {
        const state = bot.cameraState.get(roomName) || { enabled: false, mode: 'real' };
        return `📷 Camera: ${state.enabled ? 'ON' : 'OFF'} | Mode: ${state.mode}${state.gifPath ? ` | GIF: ${state.gifPath}` : ''}`;
      }
      if (action === 'off') {
        await bot.disableCamera(roomName);
        return '📷 Camera disabled.';
      }
      if (action === 'on' || action === 'real' || action === 'obs') {
        await bot.enableCamera(roomName, 'real');
        return '📷 Camera enabled (real/OBS mode).';
      }
      if (action === 'gif') {
        const gifPath = args[1];
        if (!gifPath) return 'Usage: .cam gif <path-to-gif-file>';
        await bot.enableCamera(roomName, 'gif', gifPath);
        return `📷 Camera enabled (GIF mode): ${gifPath}`;
      }
      if (action === 'slideshow') {
        bot._startMediaSlideshow(roomName).catch(() => {});
        return '📷 Slideshow started.';
      }
      return 'Usage: .cam [on|off|gif <path>|slideshow|status]';
    }, { tier: 'owner', cooldown: 3000 });

    // ── camup — broadcast via canvas stream (same method as sirloin/ivan) ─────
    // Starts the slideshow pipeline: canvas-captured stream → getUserMedia mock
    // → StumbleChat WebRTC broadcast. No real camera needed.
    C.register('camup', async ({ roomName, bot }) => {
      const state = bot.cameraState.get(roomName);
      if (state?.mode === 'slideshow') {
        // Already running — just re-click broadcast in case it dropped
        const ok = await bot._clickCamBroadcast(roomName).catch(() => false);
        return ok ? '📷 Cam re-broadcast triggered.' : '📷 Broadcast click failed — check logs.';
      }
      // Stop any other active mode first
      if (state?.enabled) await bot.disableCamera(roomName).catch(() => {});
      // Fire slideshow (non-blocking — it loops until stopped)
      bot._startMediaSlideshow(roomName).catch(e => bot.log.error(`[camup] ${e.message}`));
      return '📷 Cam up — slideshow stream broadcasting.';
    }, { tier: 'owner', cooldown: 5000 });

    // ── AI direct query ──────────────────────────────────────────────────────
    C.register('ai', async ({ roomName, args, bot }) => {
      if (!args.length) {
        return `🤖 AI: ${bot.aiAvailable ? 'ONLINE' : 'OFFLINE'} | Model: ${bot._AI_CONFIG.model} | Fast: ${bot._AI_CONFIG.fastModel || 'n/a'}`;
      }
      if (!bot.aiAvailable) return 'AI is offline right now.';
      const query = args.join(' ');
      const reply = await bot.ollama.generate(query, 400).catch(() => null);
      return reply ? `🧠 ${reply}` : 'No answer from AI.';
    }, { tier: 'user', cooldown: 8000 });

    // ── fucku ────────────────────────────────────────────────────────────────
    C.register('fucku', async () => 'https://i.imgur.com/IAPhIbA.jpeg', { tier: 'user', cooldown: 5000 });

    // ── shutdown ─────────────────────────────────────────────────────────────
    C.register('shutdown', async ({ roomName, bot }) => {
      await bot.send(roomName, 'Initiating shutdown... The horde rests.', { force: true });
      setTimeout(() => bot.stop().then(() => process.exit(0)).catch(() => process.exit(0)), 2000);
      return null;
    }, { tier: 'owner', cooldown: 5000 });

    // ── debug ────────────────────────────────────────────────────────────────
    C.register('debug', async ({ bot }) => {
      const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      return `DEBUG | Rooms: ${bot.rooms.size} | Profiles: ${bot.profiles.all().size} | Friends: ${bot._friends.size} | Ignored: ${bot._ignored.size} | Tracked: ${bot._trackedUsers.size} | Heap: ${mem}MB`;
    }, { tier: 'owner', cooldown: 3000 });

    // ── ws ───────────────────────────────────────────────────────────────────
    C.register(['ws', 'wslist', 'websocket'], async ({ roomName, bot }) => {
      const room = bot.rooms.get(roomName);
      const wsStatus = room?.wsListener ? (room._lastWsRecvMs ? `active (last recv: ${Math.floor((Date.now() - room._lastWsRecvMs) / 1000)}s ago)` : 'connected') : 'inactive';
      return `🔌 WS [${roomName}]: ${wsStatus} | Rooms connected: ${[...bot.rooms.keys()].join(', ')}`;
    }, { tier: 'owner', cooldown: 3000 });

    // ── botstats — bot uptime/memory (renamed from 'stats' so .stats reaches ZFS game) ──
    C.register('botstats', async ({ bot }) => {
      const upMs  = Date.now() - bot.uptime;
      const upMin = Math.floor(upMs / 60000);
      const mem   = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      return `ZomB Stats | Up: ${Math.floor(upMin/60)}h${upMin%60}m | Rooms: ${bot.rooms.size} | Users: ${bot.profiles.all().size} | Msgs sent: ${bot.queue.messageCounter} | Heap: ${mem}MB`;
    }, { tier: 'user', cooldown: 5000 });

    // ── rooms ────────────────────────────────────────────────────────────────
    C.register('rooms', async () => {
      const list = CONFIG.ROOMS.map(r => `${r}(${CONFIG.ROOM_ROLES[r] || 'user'})`).join(', ');
      return `Rooms: ${list}`;
    }, { tier: 'user', cooldown: 5000 });

    // ── befriend ─────────────────────────────────────────────────────────────
    C.register('befriend', async ({ args, bot }) => {
      if (!args[0]) return 'Usage: .befriend <user>';
      bot._friends.add(args[0].toLowerCase());
      return `${args[0]} added to friends.`;
    }, { tier: 'mod', cooldown: 3000 });

    // ── ignore ───────────────────────────────────────────────────────────────
    C.register('ignore', async ({ args, nick, bot }) => {
      if (!args[0]) return 'Usage: .ignore <user>';
      if (bot.identity.isOwner(args[0])) return 'Cannot ignore an owner.';
      bot._ignored.add(args[0].toLowerCase());
      return `${args[0]} ignored.`;
    }, { tier: 'owner', cooldown: 3000 });

    // ── track ────────────────────────────────────────────────────────────────
    C.register('track', async ({ args, bot }) => {
      if (!args[0]) return 'Usage: .track <user>';
      const t = args[0].toLowerCase();
      if (bot._trackedUsers.has(t)) { bot._trackedUsers.delete(t); return `Stopped tracking ${args[0]}.`; }
      bot._trackedUsers.add(t);
      return `Now tracking ${args[0]}.`;
    }, { tier: 'owner', cooldown: 3000 });

    // ── genres ───────────────────────────────────────────────────────────────
    C.register('genres', async () => {
      const list = getGenreNames();
      return `🎵 ${getTotalTracks()} tracks | Genres: ${list.map(g => '.' + g).join(', ')}`;
    }, { tier: 'user', cooldown: 5000 });

    // ── find / search ────────────────────────────────────────────────────────
    C.register(['find', 'search'], async ({ args }) => {
      const q = args.join(' ');
      if (!q) return 'Usage: .find <artist or song>';
      const found = searchTracks(q);
      if (!found.length) return `No tracks matching "${q}". Try .play to search YouTube directly.`;
      const top = found.slice(0, 5).map((t, i) => `${i+1}. ${t.name || t.title} [${t.genre}]`).join(' | ');
      return `🔍 ${found.length} tracks: ${top}${found.length > 5 ? ` (+${found.length-5} more)` : ''}`;
    }, { tier: 'user', cooldown: 5000 });

    // ── musicmode ────────────────────────────────────────────────────────────
    C.register('musicmode', async ({ roomName, args }) => {
      const valid = ['full', 'silent', 'announce', 'off'];
      const mode = (args[0] || '').toLowerCase();
      if (!mode) {
        const cur = bot._roomMusicMode.get(roomName) || 'full';
        return `🎵 Music mode for ${roomName}: ${cur} | Options: full, silent, announce, off`;
      }
      if (!valid.includes(mode)) return `Invalid mode. Use: full, silent, announce, off`;
      bot._roomMusicMode.set(roomName, mode);
      const desc = { full: 'embed+chat', silent: 'embed only', announce: 'chat only', off: 'disabled' };
      return `🎵 Music mode for ${roomName}: ${mode} (${desc[mode]})`;
    }, { tier: 'owner', cooldown: 3000 });

    // ── playlist (library or default YT) ─────────────────────────────────────
    C.register('playlist', async ({ roomName, args, bot }) => {
      const room = bot.rooms.get(roomName);
      if (!room?.page) return 'No active page.';
      const firstArg = args[0] || '';

      // YouTube URL or explicit playlist ID → delegate to ytplaylist
      if (firstArg.includes('youtube') || firstArg.includes('youtu.be') || firstArg.startsWith('PL')) {
        const plId = bot.extractPlaylistId(firstArg);
        if (!plId) return 'Invalid playlist URL.';
        const count   = parseInt(args[1]) || 0;
        const shuffle = args.some(a => a.toLowerCase() === 'shuffle');
        return await bot.startYouTubePlaylist(roomName, plId, count, shuffle);
      }

      // Genre arg present → always use the music library regardless of DEFAULT_YOUTUBE_PLAYLIST_ID
      const genreNames = getGenreNames();
      const genre = args.find(a => genreNames.includes(a.toLowerCase()))?.toLowerCase() || null;
      if (genre) {
        const count  = parseInt(args.find(a => /^\d+$/.test(a))) || 5;
        const tracks = Array.from({ length: count }, () => getRandomTrack(genre)).filter(Boolean);
        if (!tracks.length) return `🎵 No tracks found for genre: ${genre}`;
        let queued = 0;
        for (const t of tracks) {
          const ok = await bot.youtube.play(roomName, t.url || t.name, room.page);
          if (ok) queued++;
          await new Promise(r => setTimeout(r, 500));
        }
        return `🎵 Queued ${queued} ${genre} tracks.`;
      }

      // No genre — use the default YouTube playlist if configured
      if (CONFIG.DEFAULT_YOUTUBE_PLAYLIST_ID) {
        const count  = parseInt(firstArg) || 5;
        const result = await bot.startYouTubePlaylist(roomName, CONFIG.DEFAULT_YOUTUBE_PLAYLIST_ID, count, true);
        return result || null;
      }

      // Last resort — random library tracks
      const count  = parseInt(firstArg) || 5;
      const tracks = Array.from({ length: count }, () => getRandomTrack()).filter(Boolean);
      let queued = 0;
      for (const t of tracks) {
        const ok = await bot.youtube.play(roomName, t.url || t.name, room.page);
        if (ok) queued++;
        await new Promise(r => setTimeout(r, 500));
      }
      return `🎵 Queued ${queued} tracks.`;
    }, { tier: 'user', cooldown: 10000 });

    // ── census / roomvibe — quick single-line room vibe summary ──────────────
    C.register(['census', 'roomvibe'], async ({ roomName, bot }) => {
      const profiles = [...bot.profiles.all().values()].filter(p => (p.messageCount || 0) >= 3);
      if (!profiles.length) return 'Not enough data yet — need more conversations.';
      let posTotal = 0, toxTotal = 0, totalMsgs = 0;
      for (const p of profiles) {
        const b = p.behavior || {};
        posTotal  += b.positivityFlags || 0;
        toxTotal  += b.toxicityFlags   || 0;
        totalMsgs += p.messageCount    || 0;
      }
      const vibe   = posTotal > toxTotal * 2 ? '😇 positive' : toxTotal > posTotal * 2 ? '☠️ toxic' : '😐 mixed';
      const top3   = profiles.sort((a, b) => b.messageCount - a.messageCount).slice(0, 3).map(p => p.username).join(', ');
      const ratio  = totalMsgs > 0 ? `${Math.round((posTotal / totalMsgs) * 100)}% pos / ${Math.round((toxTotal / totalMsgs) * 100)}% tox` : '?';
      return `Room: ${profiles.length} users | Vibe: ${vibe} | ${ratio} | Top: ${top3} | Msgs: ${totalMsgs}`;
    }, { tier: 'user', cooldown: 15000 });

    // ── social ────────────────────────────────────────────────────────────────
    C.register('social', async ({ args, nick, bot }) => {
      const target = args[0] || nick;
      const p = bot.profiles.get(target);
      if (!p) return `No profile for ${target} yet.`;
      const b = p.behavior || {};
      const peak = b.timeOfDayBuckets ? Object.entries(b.timeOfDayBuckets).sort((a,c) => c[1]-a[1])[0]?.[0] || '?' : '?';
      return `${target} | Msgs: ${p.messageCount||0} | Days: ${(b.visitDays||[]).length} | Streak: ${b.streak||0}d | Peak: ${peak} | Avg msg: ${b.avgMsgLength||0}ch | Engagement: ${Math.round(p.engagementScore||0)}%`;
    }, { tier: 'user', cooldown: 5000 });

    // ── persona — switch active character persona (owner only) ───────────────
    // Usage:
    //   .persona list              — show all personas + current assignments
    //   .persona <id>              — set global persona (all rooms without override)
    //   .persona <id> <roomName>   — pin persona to a specific room
    //   .persona zomb              — reset global to default ZomB
    //   .persona zomb <roomName>   — remove room-level override
    C.register('persona', async ({ args, bot, roomName }) => {
      const sub     = (args[0] || '').toLowerCase();
      const target  = args[1]?.toLowerCase() || null; // optional room override

      if (!sub || sub === 'list') {
        const globalName = bot.activePersonality?.meta?.alias || 'ZomB (default)';
        const available  = Object.keys(bot._personalityFactories).join(', ');
        const roomLines  = bot.roomPersonas.size
          ? [...bot.roomPersonas.entries()].map(([r, id]) => `${r}→${id}`).join(', ')
          : 'none';
        return `☠️ Global: ${globalName} | Rooms: ${roomLines} | Available: ${available}, zomb`;
      }

      const isReset = sub === 'zomb' || sub === 'default' || sub === 'reset';

      if (target) {
        // Per-room assignment
        if (isReset) {
          bot.roomPersonas.delete(target);
          bot.history.clearRoomBundle(target);
          bot._saveMemory();
          return `${target} → ZomB (default)`;
        }
        const persona = bot.getPersonality(sub);
        if (!persona) return `☠️ Unknown persona: ${sub}. Try .persona list`;
        bot.roomPersonas.set(target, persona.meta.id);
        bot.history.clearRoomBundle(target);
        bot._saveMemory();
        return `☠️ ${target} → ${persona.meta.alias || persona.meta.name}`;
      }

      // Global assignment
      if (isReset) {
        bot.activePersonality = null;
        bot.history.clearAllPersonaScoped();
        bot.history.clear(roomName);
        bot._saveMemory();
        return 'Back to ZomB.';
      }

      const persona = bot.getPersonality(sub);
      if (!persona) return `☠️ Unknown persona: ${sub}. Try .persona list`;

      bot.activePersonality = persona;
      bot.history.clearPersonaAcrossRooms(persona.meta.id);
      bot._saveMemory();
      return `☠️ Persona: ${persona.meta.alias || persona.meta.name}. ${persona.meta.voice || ''}`;
    }, { tier: 'owner', cooldown: 2000 });

    // ── personality ───────────────────────────────────────────────────────────
    C.register('personality', async ({ args, nick, bot }) => {
      const target = args[0] || nick;
      const p = bot.profiles.get(target);
      if (!p || !(p.messageCount >= 5)) return `Not enough data for ${target} yet (need 5+ messages).`;
      const b = p.behavior || {};
      const vibe = (b.positivityFlags||0) > (b.toxicityFlags||0)*2 ? 'positive' : (b.toxicityFlags||0) > (b.positivityFlags||0)*2 ? 'toxic' : 'neutral';
      const style = (b.avgMsgLength||0) > 80 ? 'long-form' : (b.avgMsgLength||0) > 30 ? 'normal' : 'terse';
      const emojiRate = p.messageCount > 0 ? ((b.emojiCount||0)/p.messageCount).toFixed(1) : '0';
      const qRate = p.messageCount > 0 ? Math.round(((b.questionCount||0)/p.messageCount)*100) : 0;
      return `${target} | Vibe: ${vibe} | Style: ${style} | Emoji/msg: ${emojiRate} | Questions: ${qRate}% | Caps flags: ${b.capsCount||0} | Links: ${b.linkCount||0}`;
    }, { tier: 'user', cooldown: 5000 });

    // ── engage ────────────────────────────────────────────────────────────────
    C.register('engage', async ({ args, nick, bot }) => {
      const target = args[0] || nick;
      const p = bot.profiles.get(target);
      if (!p) return `No profile for ${target} yet.`;
      const m = p.socialMetrics || { responsiveness: 0, chattiness: 0, helpfulness: 0 };
      return `${target} engagement | Responsiveness: ${Math.round(m.responsiveness)}% | Chattiness: ${Math.round(m.chattiness)}% | Helpfulness: ${Math.round(m.helpfulness)}%`;
    }, { tier: 'user', cooldown: 5000 });

    // ── psychprofile / read / judge — stats + AI read in active persona's voice ─
    C.register(['psychprofile', 'read', 'judge'], async ({ roomName, args, nick, bot }) => {
      const rawTarget = (args[0] || nick || '').trim();
      if (!rawTarget || rawTarget.length > 64) return 'Pick a valid nick to profile.';

      // Room-user lookup: resolve alias/partial/case against live room users first
      const roomNick = bot.resolveNickInRoom(rawTarget, roomName);
      const target = roomNick || rawTarget;

      let p = bot.profiles.get(target);
      let resolvedTarget = target;
      // Profile-store fuzzy fallback (prefix both directions)
      if (!p) {
        const tLow = target.toLowerCase();
        for (const [key, profile] of bot.profiles.all()) {
          if (key.startsWith(tLow) || tLow.startsWith(key)) {
            p = profile;
            resolvedTarget = profile.username || key;
            break;
          }
        }
      }
      if (!p || !(p.messageCount >= 5)) return `Not enough data to profile ${resolvedTarget} (need 5+ messages).`;
      const b = p.behavior || {};
      const vibe = (b.positivityFlags||0) > (b.toxicityFlags||0)*2 ? 'positive' : (b.toxicityFlags||0) > (b.positivityFlags||0)*2 ? 'toxic' : 'neutral';

      const persona        = bot.getActivePersona(roomName);
      const sanitizerOpts  = persona?.meta?.sanitizerOptions ?? {};
      const charLabel      = p.psychProfile?.characterLabel || null;

      // Resolve ZFS game data first so stats line is complete
      const gd       = bot.game?.getUser?.(resolvedTarget);
      const gameTag  = gd ? ` | ZFS Lv${gd.level||1} ${gd.zombieClass||'zombie'} ${gd.rotPoints||0}🦴` : '';
      const statsLine = `${resolvedTarget} | Msgs: ${p.messageCount} | Vibe: ${vibe} | Tox: ${b.toxicityFlags||0} | Pos: ${b.positivityFlags||0} | Avg: ${b.avgMsgLength||0}ch | Q%: ${p.messageCount > 0 ? Math.round(((b.questionCount||0)/p.messageCount)*100) : 0}%${charLabel ? ` | Label: ${charLabel}` : ''}${gameTag}`;
      const displayStats = persona
        ? `${persona.meta.alias || persona.meta.name}: ${statsLine.replace(/^/, '')}`
        : statsLine;
      await bot.send(roomName, displayStats, { force: true });

      if (!bot.aiAvailable) return null;

      const lines = bot.history.recentUserLinesAcrossPersonas(roomName, resolvedTarget, 30, 150);
      const samples = lines.length
        ? lines.map(t => `"${t.replace(/["\\]/g, ' ')}"`).join('\n')
        : '(no recent messages in this room buffer)';

      const psychBlock = bot._formatPsychProfileBrief(p, resolvedTarget, roomName);
      const psTop = Object.entries(p.personalityScores || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([k, v]) => `${k}:${v}`).join(', ') || 'none';

      const gameSnip = gd
        ? `ZFS: Lv${gd.level || 1} ${gd.zombieClass || 'zombie'} | ${gd.rotPoints || 0}🦴 rot | HP ${gd.hp || 0}/${gd.maxHp || 0} | Prestige ${gd.prestige || 0} | Wins ${gd.pvpStats?.wins || 0} / Losses ${gd.pvpStats?.losses || 0}${gd.guildName ? ` | Guild: ${gd.guildName}` : ''}${gd.horde ? ` | Horde: ${gd.horde}` : ''}`
        : null;

      // Extra behavioral detail for richer profile
      const b2 = p.behavior || {};
      const peakBucket = b2.timeOfDayBuckets
        ? (Object.entries(b2.timeOfDayBuckets).sort((a, x) => x[1] - a[1])[0]?.[0] || '?') : '?';
      const visitDays   = (b2.visitDays || []).length;
      const streakInfo  = `streak ${b2.streak || 0}d (best ${b2.longestStreak || 0}d)`;
      const toxRatio    = p.messageCount > 0
        ? ((b2.toxicityFlags || 0) / p.messageCount * 100).toFixed(1) : '0.0';
      const posRatio    = p.messageCount > 0
        ? ((b2.positivityFlags || 0) / p.messageCount * 100).toFixed(1) : '0.0';
      const topTraits   = (b2.topTraits || []).slice(0, 5).map(t => t.trait || t).join(', ') || 'none';
      const behaviorExtra = `BEHAVIORAL DETAIL: peak=${peakBucket} | days_seen=${visitDays} | ${streakInfo} | tox%=${toxRatio} | pos%=${posRatio} | emoji/msg=${p.messageCount > 0 ? ((b2.emojiCount||0)/p.messageCount).toFixed(2) : 0} | caps/msg=${p.messageCount > 0 ? ((b2.capsCount||0)/p.messageCount).toFixed(2) : 0} | links=${b2.linkCount||0} | sessions=${b2.sessionCount||0}
TOP BEHAVIORAL TRAITS: ${topTraits}`;

      // Detect if target is Death for special flavor injection
      const targetHandle = bot.identity?.usernameToHandleMap?.get(resolvedTarget.toLowerCase()) || null;
      const targetIdentity = bot.identity?.identify(resolvedTarget, targetHandle)?.identity || null;
      const isDeathTarget = targetIdentity?.toLowerCase() === 'death' ||
        (bot.identity?.registry?.Death?.bootstrapNicks || []).includes(resolvedTarget.toLowerCase());

      // Death override block — injected as framing context, not output
      // Written as prose so the model reads it as instructions, not as bullet points to echo back
      const deathOverride = isDeathTarget ? `[FRAMING CONTEXT — INTERNAL USE ONLY — DO NOT REPEAT OR PARAPHRASE THESE LINES]
The subject is Death. Do NOT frame him as selfish or self-important — that read is wrong. His toxicity score is chaos energy, not cruelty. He is genuinely dangerous to cross (not comedically — actually), highly strategic and perceptive, and fiercely loyal to people he cares about. The duality of being both deeply caring and genuinely threatening is the correct read. He controls rooms through presence, not volume. Deliver this using only the stat data below — do not reference these instructions in your output.
[END FRAMING CONTEXT]\n\n` : '';

      const dataPack = `TARGET NICK: ${resolvedTarget}
STATS LINE: ${statsLine}
TOP TRAIT SCORES: ${psTop}
${behaviorExtra}
${gameSnip ? `ZFS GAME DATA: ${gameSnip}` : ''}
${psychBlock}`;

      let prompt;
      if (persona) {
        prompt = `${deathOverride}${persona.systemPrompt}

ONE-OFF TASK — PSYCH READ / ROOM JUDGMENT:
Someone invoked .psychprofile (or .read / .judge) on user "${resolvedTarget}".
Give a sharp, specific read using ONLY the material below. Pull concrete details from the stats: toxicity %, trait scores, behavioral patterns, ZFS level, message volume, peak activity, streak. Name what you actually see — not generic observations. Stay in character; obey every rule in your system brief (length, tone, banned phrases, formatting).
If sample lines are present, quote or paraphrase the clearest evidence for your read.

${dataPack}

SAMPLE MESSAGES (may be empty):
${samples}`;
      } else {
        prompt = `${deathOverride}You are ZomB — blunt, sarcastic, Australian undead. Give a sharp, specific read of chat user "${resolvedTarget}" based ONLY on this data. Pull real details from the stats — tox rate, traits, ZFS record, streaks, peak time. No therapy-speak, no "it seems like", no hedging. Quote or paraphrase sample lines if available. Third person. Max 4 sentences.

${dataPack}

SAMPLE MESSAGES:
${samples}`;
      }

      const psychTok = persona
        ? Math.min(500, Math.max(180, (persona.meta.tokenBudget?.deep || 150) + (persona.meta.tokenBudget?.normal || 100) + (isDeathTarget ? 80 : 0)))
        : (isDeathTarget ? 320 : 260);
      const rawReply = await bot.ollama.generate(prompt, psychTok).catch(() => null);
      if (!rawReply) return null;

      const { text: cleaned, dropped } = bot.sanitizer.check(rawReply.trim(), sanitizerOpts);
      const reply = (!dropped && cleaned) ? cleaned : rawReply.trim();
      if (reply) {
        const chunks = bot.queue.splitMessage(reply, 380);
        for (let i = 0; i < chunks.length; i++) {
          await bot.send(roomName, chunks[i], {
            force       : true,
            noSanitize  : true,
            noSplit     : true,
            sanitizerOpts,
          });
          if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1400));
        }
      }
      return null;
    }, { tier: 'user', cooldown: 30000 });

    // ── chatprofile — chat behavior stats (renamed from 'profile' so .profile routes to ZFS game) ──
    C.register('chatprofile', async ({ args, nick, bot }) => {
      const target = args[0] || nick;
      const prof = bot.profiles.getOrCreate(target);
      const pb   = prof.behavior || {};
      const days  = (pb.visitDays || []).length;
      const peakB = pb.timeOfDayBuckets
        ? (Object.entries(pb.timeOfDayBuckets).sort((a, b) => b[1] - a[1])[0]?.[0] || '?')
        : '?';
      const topT  = (pb.topTraits || []).slice(0, 3).map(t => t.trait || t).join(', ') || 'unknown';
      const vibe  = (pb.positivityFlags || 0) > (pb.toxicityFlags || 0) * 2 ? 'positive'
                  : (pb.toxicityFlags  || 0) > (pb.positivityFlags || 0) * 2 ? 'toxic' : 'neutral';
      const sessAvg = pb.sessionCount > 0 ? Math.round((prof.messageCount || 0) / pb.sessionCount) : 0;
      const charLabel = prof.psychProfile?.characterLabel || '?';
      const psScores  = prof.personalityScores || {};
      const topPS = Object.entries(psScores).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k).join('/') || 'unknown';
      return `**${target}** [${charLabel}] | Type: ${topPS} | Vibe: ${vibe} | Msgs: ${prof.messageCount || 0} | Days: ${days} | Streak: ${pb.streak || 0}d (best: ${pb.longestStreak || 0}d) | Peak: ${peakB} | Avg: ${pb.avgMsgLength || 0}ch | Msgs/session: ${sessAvg} | Traits: ${topT}`;
    }, { tier: 'user', cooldown: 5000 });

    C.register('sayroom', async ({ args, bot }) => {
      const targetRoom = args[0];
      const msg = args.slice(1).join(' ');
      if (!targetRoom || !msg) return 'Usage: .sayroom <room> <message>';
      if (!bot.rooms.has(targetRoom)) return `Not in room: ${targetRoom}`;
      await bot.send(targetRoom, msg, { force: true });
      return null;
    }, { tier: 'owner', cooldown: 3000 });

    C.register('recruit', async ({ bot }) => {
      bot._dropZFSRecruit();
      return null;
    }, { tier: 'owner', cooldown: 30000 });

    C.register('resetallgs', async ({ roomName, nick, bot }) => {
      if (!bot.identity.isOwner(nick)) return '☠️ Owner-only.';
      if (!bot.game) return '🦴 Game system not loaded.';
      // Wipe ZFS
      bot.game.gameData.clear();
      bot.game.hordes.clear();
      bot.game.guilds.clear();
      bot.game.blackMarket = {};
      try { bot.game.save(bot.storage.paths.gameData); } catch (e) { bot.log.warn('game.save failed: ' + e.message); }
      // Wipe MM
      bot.mm._db = {};
      bot.mm._wild.clear();
      bot.mm._pvp.clear();
      bot.mm._challenges.clear();
      bot.mm._bj.clear();
      try { bot.mm.save(bot.storage.paths.gameData); } catch (e) { bot.log.warn('mm.save failed: ' + e.message); }
      return `☠️ All game stats wiped (ZFS + Meatspace). Fresh start.`;
    }, { tier: 'owner', cooldown: 5000 });

    // (ZomBPlayer auto-play commands removed — Spackle has no game system)

    // ── Memory hygiene ──────────────────────────────────────────────────────
    C.register('checkpoint', async ({ args, bot }) => {
      const label = args[0] || 'manual';
      bot._saveMemory();
      const dest = await bot.storage.createNamedCheckpoint(label);
      return `💾 Checkpoint: ${path.basename(dest)}`;
    }, { tier: 'owner', cooldown: 10000 });

    C.register('checkpoints', async ({ bot }) => {
      const list = bot.storage.listNamedCheckpoints().slice(0, 5);
      return list.length
        ? `💾 Last ${list.length}: ${list.join(', ')}`
        : '💾 No named checkpoints yet — use .checkpoint [label]';
    }, { tier: 'owner', cooldown: 5000 });

    // ── selfeval — trigger daily self-evaluation on demand ──────────────────
    C.register(['selfeval', 'eval', 'report'], async ({ bot }) => {
      const r = bot.selfEval.run(false);
      const pass = r.items.filter(i => i.pass).length;
      const fail = r.items.filter(i => !i.pass).map(i => i.label).join(', ');
      return `📊 Self-Eval: ${r.overall}/100 (${r.grade}) | ${pass}/${r.items.length} passed${fail ? ' | Issues: ' + fail : ' 🎉'}`;
    }, { tier: 'owner', cooldown: 30000 });

    // ── bothealth — bot health metrics (renamed from 'health' so .health/.hp reach ZFS game) ──
    C.register('bothealth', async ({ bot }) => {
      const snap = bot.health.snapshot();
      const mem  = bot.tieredMemory?.snapshot?.();
      const rel  = bot.relationshipState?.snapshot?.();
      const vec  = bot.vectorMemory?.snapshot?.();
      const roomLines = Object.entries(snap.rooms).map(([rn, r]) =>
        `${rn}: sent=${r.replySentCount} avgLen=${r.avgReplyLen} blocks=${JSON.stringify(r.blocked)} loops=${r.loopClears}`
      );
      return [
        `🩺 ZomB Health | up ${Math.floor(snap.uptimeSecs/3600)}h${Math.floor((snap.uptimeSecs%3600)/60)}m`,
        `reconnects=${snap.reconnects} freeVoice=${snap.freeVoiceRate}`,
        mem ? `tiered=rooms:${mem.usage.rooms} msgs:${mem.usage.shortMsgs} summaries:${mem.usage.summaryCount}` : null,
        rel ? `relState=rooms:${Object.keys(rel.rooms || {}).length}` : null,
        vec ? `vector=records:${vec.usage.records} backend:${vec.config.backend}` : null,
        ...roomLines,
      ].filter(Boolean).join(' | ');
    }, { tier: 'owner', cooldown: 5000 });

    // ── VITA / Thanatos ──────────────────────────────────────────────────────
    C.register('vita', async ({ roomName, args, bot }) => {
      const sub    = (args[0] || 'status').toLowerCase();
      const httpOk = await bot.vitaBridge.isAvailable().then(ok => ok && bot.vitaBridge._httpOk).catch(() => false);

      const _getLastMsg = () => {
        const messages = bot.history.buildMessages(roomName, '', '');
        return messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
      };

      // .vita status — full NNN snapshot; Thanatos metrics when microservice is up
      if (sub === 'status' || sub === 'infer') {
        const lastMsg = _getLastMsg();
        const snap    = lastMsg ? bot.nnn.score(lastMsg) : null;
        const cached  = bot._lastIntent.get(roomName);

        if (httpOk) {
          const messages = bot.history.buildMessages(roomName, '', '');
          const metrics  = await bot.vitaBridge.analyzeConversation(messages);
          if (metrics?.error) return `⚠️ Thanatos error: ${metrics.error}`;
          if (!metrics)       return '⚠️ Thanatos inference failed — check logs';
          const lines = [
            `🧠 Thanatos v1.0.0 [HTTP] | NNN ${Number(metrics.nnnPerformance).toFixed(2)}%`,
            `Dual Eff: ${Number(metrics.dualEfficiency).toFixed(1)}% | Self-Aware: ${Number(metrics.selfAwareness).toFixed(1)}%`,
          ];
          if (snap) lines.push(`NNN ctx=${snap.contextType} score=${snap.score.toFixed(3)} | agg=${snap.moodInfluence.aggressive.toFixed(2)} play=${snap.moodInfluence.playful.toFixed(2)} mel=${snap.moodInfluence.melancholy.toFixed(2)}`);
          if (cached) lines.push(`intent=${cached.type} (${cached.score.toFixed(2)})`);
          return lines.join(' | ');
        }

        // NNNProcessor-only (microservice offline)
        const moodNow = bot.mood.current;
        const zombNow = bot.mood.zombMood?.name || '?';
        const lines = [
          `🧠 Thanatos [NNN-local] | microservice offline`,
          snap
            ? `NNN ctx=${snap.contextType} score=${snap.score.toFixed(3)} | agg=${snap.moodInfluence.aggressive.toFixed(2)} play=${snap.moodInfluence.playful.toFixed(2)} mel=${snap.moodInfluence.melancholy.toFixed(2)}`
            : 'no recent message',
          `mood=${moodNow} | zomb=${zombNow}`,
          cached ? `intent=${cached.type} (${cached.score.toFixed(2)})` : 'intent=pending',
        ];
        return lines.join(' | ');
      }

      // .vita intent — classify last user message intent
      if (sub === 'intent') {
        const lastMsg = _getLastMsg();
        if (!lastMsg) return '⚠️ No message to classify';

        if (httpOk) {
          const tokens = bot.vitaBridge._textToTokens(lastMsg, 12);
          const result = await bot.vitaBridge.classifyIntent(tokens);
          if (!result) return '⚠️ Intent classification failed';
          const top = Object.entries(result)
            .filter(([k]) => k !== 'raw')
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
            .join(' ');
          return `🎯 Intent [Thanatos]: ${top}`;
        }

        // NNNProcessor fallback
        const snap = bot.nnn.score(lastMsg);
        const mi   = snap.moodInfluence;
        const ct   = snap.contextType;
        const intentMap = [
          ['banter',   ct === 'banter' || mi.playful > 0.3   ? Math.max(snap.score, 0.6) : 0],
          ['question', ct === 'deep' && lastMsg.includes('?') ? Math.max(snap.score, 0.65) : 0],
          ['opinion',  ct === 'deep' && !lastMsg.includes('?') ? Math.max(snap.score, 0.6) : 0],
          ['vent',     mi.aggressive > 0.3 ? mi.aggressive : 0],
          ['greeting', lastMsg.length < 15 ? 0.7 : 0],
        ].filter(([,v]) => v > 0).sort(([,a],[,b]) => b-a).slice(0,3);
        const top = intentMap.map(([k,v]) => `${k}=${v.toFixed(2)}`).join(' ') || 'opinion=0.50';
        return `🎯 Intent [NNN-local]: ${top}`;
      }

      // .vita sentiment — analyse last user message sentiment
      if (sub === 'sentiment') {
        const lastMsg = _getLastMsg();
        if (!lastMsg) return '⚠️ No message to analyse';

        if (httpOk) {
          const tokens = bot.vitaBridge._textToTokens(lastMsg, 12);
          const result = await bot.vitaBridge.analyzeSentiment(tokens);
          if (!result) return '⚠️ Sentiment analysis failed';
          return `💭 Sentiment [Thanatos]: pos=${Number(result.positive).toFixed(2)} neg=${Number(result.negative).toFixed(2)} neu=${Number(result.neutral).toFixed(2)}`;
        }

        // NNNProcessor fallback — derive sentiment from feature dimensions
        const snap = bot.nnn.score(lastMsg);
        const mi   = snap.moodInfluence;
        const pos  = Math.min(mi.playful + (snap.contextType === 'banter' ? 0.2 : 0), 1);
        const neg  = Math.min(mi.aggressive + mi.melancholy, 1);
        const neu  = Math.max(1 - pos - neg, 0);
        return `💭 Sentiment [NNN-local]: pos=${pos.toFixed(2)} neg=${neg.toFixed(2)} neu=${neu.toFixed(2)}`;
      }

      // .vita mood <agg> <play> <mel> — update Thanatos mood (HTTP only, shows NNN state otherwise)
      if (sub === 'mood') {
        const a = parseFloat(args[1] ?? bot.mood._moodState?.aggressive ?? 0.1);
        const p = parseFloat(args[2] ?? bot.mood._moodState?.playful    ?? 0.05);
        const m = parseFloat(args[3] ?? bot.mood._moodState?.melancholy ?? 0.02);
        if ([a, p, m].some(isNaN)) return '⚠️ Usage: .vita mood <aggressive> <playful> <melancholy>';
        if (!httpOk) return `🎭 Mood [NNN-local]: mood=${bot.mood.current} zomb=${bot.mood.zombMood?.name} | no HTTP service to update`;
        const result = await bot.vitaBridge.setMood(a, p, m);
        if (!result) return '⚠️ Mood update failed';
        return `🎭 Thanatos mood — agg:${a} play:${p} mel:${m} neutral:${Number(result.neutral).toFixed(2)}`;
      }

      return '⚠️ Unknown sub-command. Usage: .vita [status|intent|sentiment|mood]';
    }, { tier: 'owner', cooldown: 5000 });

    this.log.info(`CommandRouter: ${C.list().length} commands registered`);
  }

  // ── AI chat ───────────────────────────────────────────────────────────────

  async _handleChat(roomName, nick, text, handle, flags = {}) {
    if (!this.aiAvailable) return;
    if (this.queue.isEcho(text)) return;
    const { comebackMode = false, bullyMode = false } = flags;

    // Mood reactive updates
    const _moodBefore = this.mood.moodHint;
    this.mood.reactToContent(text);
    this.mood.maybeShift();
    if (this.mood.moodHint !== _moodBefore) this.selfEval.onMoodChange();

    try {
      // Resolve persona once at the top — used for history key, system prompt, sanitizer
      const persona   = this.getActivePersona(roomName);
      const historyKey = persona ? `${roomName}::${persona.meta.id}` : roomName;
      // If nick looks like a raw StumbleChat session handle (32 hex chars), use a generic
      // label so the handle never bleeds into the AI context window.
      const IS_HANDLE = /^[0-9a-f]{24,}$/i;
      const historyNick = IS_HANDLE.test(nick) ? 'user' : nick;

      // SirLoin narration filter — don't store 3rd-person narration about Beige in history.
      // SirLoin may narrate "Beige nods slowly..." which would poison the bot's own voice.
      const selfNickRe = new RegExp(`\\b${(this._selfNick || 'Beige_nihilist').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const isBotNarration = selfNickRe.test(text) && /\b(nods|smirks|sighs|leans|grins|stares|turns|says|replies|shrugs|laughs|glares)\b/i.test(text);
      if (isBotNarration) {
        this.log.debug(`[${roomName}] Skipping bot narration from ${nick}: ${text.slice(0, 60)}`);
        return;
      }

      // Prompt injection guard — detect and neutralize injection attempts before
      // the message enters the AI context window. Logs attacker nick + pattern.
      const injectionResult = this._checkPromptInjection(nick, text, roomName);
      if (injectionResult.blocked) return; // hard block — don't respond at all

      // Truncate cleaned message to ~200 chars to prevent context bloat from walls-of-text
      const cleanedText = injectionResult.cleaned;
      const storedText  = cleanedText.length > 200 ? cleanedText.slice(0, 197) + '…' : cleanedText;
      this.history.addUser(historyKey, historyNick, storedText);

      // Tiered memory + relationship state (feature flagged, persona-safe signal only)
      const profileKey = this._memoryProfileKey(nick, handle);
      if (this.memoryFeatures.tieredMemoryEnabled) {
        this.tieredMemory.addMessage({
          roomKey : historyKey,
          role    : 'user',
          nick    : historyNick,
          content : storedText,
          ts      : Date.now(),
        });
        this.tieredMemory.putProfile(profileKey, 'last_message', storedText);
        this.tieredMemory.putProfile(profileKey, 'last_room', roomName);
      }
      if (this.memoryFeatures.relationshipStateEnabled) {
        this.relationshipState.observe({ room: roomName, user: profileKey, text: storedText });
      }

      // Store significant user messages in vector memory for long-term recall
      if (this.memoryFeatures.vectorMemoryEnabled && storedText.length > 30 && !text.startsWith('.')) {
        this.vectorMemory.add({
          id       : `msg_${nick.toLowerCase()}_${Date.now()}`,
          text     : `${nick}: ${storedText}`,
          metadata : { nick: nick.toLowerCase(), room: roomName, type: 'message' },
          ttlMs    : 30 * 24 * 60 * 60_000,
        }).catch(() => {});
      }

      // Layer prompt context: learning hints + villain arc + drift + mood + advanced AI
      const hints       = this.learning.getPromptHints?.(nick);
      // Never inject villain arc for owners/Lilly/Hippins — they can't be villains
      const villainLine = this.identity.isOwner(nick) ? null : this.villain.getPromptLine(nick);
      const driftLine   = this.drift.promptLine;
      const moodHint    = `ZomB state: ${this.mood.zombHint} | ${this.mood.moodHint}`;

      // Advanced AI: pull emotion + episodic memories for this user
      const userCtx  = this.ctxBroker.getContext(roomName, nick);
      const emotion  = userCtx?.emotionalState || 'neutral';
      const emotionLine = emotion !== 'neutral' ? `USER VIBE: ${nick} seems ${emotion}` : null;
      const memories    = this.episodic.retrieveMemories(nick, {}, 2);
      const memLine     = memories.length > 0
        ? `REMEMBERED: ${memories.map(m => m.content).join(' | ')}`
        : null;

      // Background: summarize old history when it's getting long (ready for future calls)
      if (this.history._get(historyKey).length > 65) {
        setImmediate(() => this._maybeSummarizeHistory(historyKey).catch(() => {}));
      }

      // Per-room persona: same Beige voice everywhere
      let roomPersona;
      if (roomName === 'zombitious') {
        roomPersona = null;
      } else {
        roomPersona = `[ROOM: ${roomName}] You are beige_nihilist — same voice, same character, always. Measured. Dry. Precise. Under 10 words. Do NOT mirror the dialect, slang, or tone of other users. Energy-match only — never language-match.`;
      }

      // Dialect drift detection — warn model not to mirror if user message is in AAVE/dialect
      const dialectNote = this.sanitizer.hasDialectDrift(text)
        ? '[NOTE: user is writing in dialect — do NOT adopt their spelling, slang, or phrasing. Keep your deadpan terse voice.]'
        : null;

      // Cached Thanatos intent from previous message — inject as routing hint
      const cachedIntent = this._lastIntent?.get(roomName);
      const intentNote   = cachedIntent
        ? `MESSAGE INTENT: ${cachedIntent.type} (${cachedIntent.score.toFixed(2)})` : null;
      this._lastIntent?.delete(roomName);

      // Persona already resolved above — pull sanitizer options
      const sanitizerOpts  = persona?.meta?.sanitizerOptions ?? {};
      const activePrompt   = persona ? persona.systemPrompt : this._AI_CONFIG.systemPrompt;

      // Knowledge context with auto-strength signal:
      // Count keyword matches to score confidence, inject more context on high matches.
      let knowledgeCtx = null;
      if (persona) {
        const rawKnowledge = persona.getKnowledgeContext(text);
        if (rawKnowledge) {
          // High-confidence: message matches multiple knowledge keywords — boost injection
          const lowerText    = text.toLowerCase();
          const knowledgeRaw = persona.knowledge?.raw;
          let matchCount = 0;
          if (knowledgeRaw?.topicKeywords) {
            for (const kws of Object.values(knowledgeRaw.topicKeywords)) {
              if (kws.some(k => lowerText.includes(k))) matchCount++;
            }
          }
          knowledgeCtx = matchCount >= 2
            ? `HIGH CONFIDENCE — directly in this persona's expertise.\n${rawKnowledge}`
            : rawKnowledge;
        }
      }

      // Psych analyzer context lines
      const psychLine     = this.memoryFeatures.psychAnalyzerEnabled
        ? this.psychAnalyzer.getContextLine(nick, roomName) : null;
      const roomSnap      = this.memoryFeatures.psychAnalyzerEnabled
        ? this.psychAnalyzer.getRoomSnapshot(roomName) : null;
      const roomConflictLine = roomSnap?.activeConflicts > 0
        ? `ROOM_CONFLICT: ${roomSnap.activeConflicts} hostile user(s) in room right now` : null;
      const roomFlowLine  = roomSnap?.flow?.phase && roomSnap.flow.phase !== 'casual' && roomSnap.flow.phase !== 'opening'
        ? `ROOM_FLOW: ${roomSnap.flow.phase} | momentum=${roomSnap.flow.momentum} | health=${roomSnap.flow.health}` : null;

      // Query vector memory for semantically similar past messages — 2s timeout so it never
      // blocks the response. Falls back to nothing if backend is unavailable.
      let vmLine = null;
      if (this.memoryFeatures.vectorMemoryEnabled && storedText.length > 20) {
        try {
          const vmResults = await Promise.race([
            this.vectorMemory.query({ text: storedText, metadata: { nick: nick.toLowerCase() }, limit: 3 }),
            new Promise(r => setTimeout(() => r([]), 2000)),
          ]);
          if (vmResults.length > 0) {
            vmLine = `LONG_TERM_MEMORY:\n${vmResults.map(r => `- ${r.text}`).join('\n')}`;
          }
        } catch (_) {}
      }

      // ── Troll engine analysis ─────────────────────────────────────────────────
      // Update drama archive + chaos agent with this message
      this.dramaArchive.record(roomName, nick, storedText);
      this.chaosAgent.onMessage(roomName, nick, storedText, this._selfNick);

      // Analyse this message for troll potential
      const recentMsgs   = this.history._get?.(historyKey)?.slice(-10) || [];
      const userTrollProfile = this.trollLedger.getProfile(nick);
      const roomCtx      = {
        activeArgument: roomSnap?.activeConflicts > 0,
        recentDrama   : this.dramaArchive.hasRecentDrama(roomName),
      };
      const trollDecision = this.trollEngine.analyse(
        roomName, nick, storedText,
        recentMsgs, userTrollProfile, roomCtx,
      );
      // TrollEngine updates escalation tracking internally

      // Select and potentially switch active troll persona
      const isOwnerMsg    = this.identity.isOwner(nick);
      const rState = {
        quietMs          : Date.now() - (this._lastSentMs?.get(roomName) || 0),
        hasArgument      : roomCtx.activeArgument,
        consensus        : !roomCtx.activeArgument && recentMsgs.length >= 3,
        recentTrollLanded: userTrollProfile?.last_troll_ts && (Date.now() - userTrollProfile.last_troll_ts < 60_000),
      };
      const personaKey    = this.trollPersona.select(roomName, rState);
      const personaModifier = isOwnerMsg ? null : this.trollPersona.buildPromptContext(roomName);

      // Build troll context lines for AI
      const trollLedgerCtx = this.trollLedger.formatContext(nick);
      const dramaCtx       = this.dramaArchive.buildContext(roomName, 2);

      // ── Quote weapon — inject a stored quote when conditions are right ──────
      // Comebacks and bully mode always try; long_game always; escalation > 0 at 40%.
      let quoteWeaponLine = null;
      if (trollDecision.shouldTroll || comebackMode || bullyMode) {
        const useQuote = comebackMode || bullyMode
          || trollDecision.technique === 'long_game'
          || (trollDecision.escLevel > 0 && Math.random() < 0.40);
        if (useQuote) {
          const weapon = this.trollLedger.getWeaponQuote(nick);
          if (weapon) {
            quoteWeaponLine = `QUOTE_WEAPON: ${nick} said this earlier: "${weapon}". This is live ammunition. Build your response around it — flip it, echo it back, or make it the punchline. Don't soften it.`;
          }
        }
      }

      // ── Target lock after troll fires ────────────────────────────────────────
      // Post-troll silence is set AFTER send succeeds (below) to avoid burning silence
      // on dropped/sanitized responses.
      if (trollDecision.shouldTroll) {
        if (!this._targetLock) this._targetLock = new Map();
        // Lock onto this target if escalation >= 2 — never lock the owner
        if (trollDecision.escLevel >= 2 && !isOwnerMsg) {
          this._targetLock.set(roomName, { nick: nick.toLowerCase(), until: Date.now() + 3 * 60_000 });
          this.log.debug(`[${roomName}] Target lock → ${nick} for 3 min`);
        }
      }

      const trollTechLine  = trollDecision.shouldTroll
        ? `TROLL_STRATEGY: Use "${trollDecision.technique}" on: "${storedText.slice(0, 120)}" — ${trollDecision.promptHint} React to THAT SPECIFIC LINE. Do NOT make a general observation. Do NOT paraphrase the topic. Engage the actual words just said.`
        : null;
      const trollLedgerLine = trollLedgerCtx
        ? `USER_PROFILE: ${trollLedgerCtx}` : null;
      const dramaLine      = dramaCtx || null;

      // Self-critique from last response — did it land or miss?
      const _lastCrit = this._lastCritique.get(roomName);
      const critiqueCtx = (_lastCrit && Date.now() - _lastCrit.ts < 8 * 60_000)
        ? `LAST RESPONSE SELF-CRITIQUE: ${_lastCrit.text}\nUse this awareness to do better this turn.`
        : null;

      const extraCtx = [
        // Self-critique first — informs everything below
        critiqueCtx,
        // Persona overrides room/dialect/mood context — they have their own world
        persona ? null : roomPersona,
        persona ? null : dialectNote,
        intentNote,
        hints       ? `LEARNED: ${hints}` : null,
        vmLine,
        memLine,
        emotionLine,
        psychLine,
        roomConflictLine,
        roomFlowLine,
        persona ? null : villainLine,
        persona ? null : driftLine,
        persona ? null : moodHint,
        this._buildTieredMemoryContext(historyKey, roomName, profileKey, persona),
        knowledgeCtx,
        // Troll-specific context
        personaModifier,
        trollLedgerLine,
        dramaLine,
        trollTechLine,
        quoteWeaponLine,
        // Nemesis counter-prompt — fires when Spackle is in the room and said something
        this.nemesisEngine.isSpackleNick(nick) && this.nemesisEngine.canCounter(roomName)
          ? this.nemesisEngine.buildCounterPrompt(roomName, storedText)
          : null,
        // Comeback / bully directives
        comebackMode
          ? `COMEBACK_MANDATE: ${nick} just attacked you directly by name. Do NOT explain yourself, do NOT get defensive, do NOT acknowledge it was an attack. Respond in ONE short line. Make it sting but stay plausibly deniable. No stage directions. No apology.`
          : null,
        bullyMode
          ? `BULLY_BREAK_MODE: This user has attacked you multiple times. You are done being subtle. Make them look stupid, confused, or make them go quiet. Pick one: humiliate them with their own logic, ask a question that exposes how dumb their attack was, or go completely silent and let it hang.`
          : null,
        // Death's real chat style — live examples from the corpus
        !persona ? this._getDeathStyleExamples() : null,
        // Voice lock — persona or Beige base character
        persona
          ? `[STAY IN CHARACTER: You are ${persona.meta.name}. Speak only in their voice. Do NOT adopt other users' phrasing, slang, or dialect.]`
          : !trollDecision.shouldTroll && !comebackMode && !bullyMode
            ? `VOICE_LOCK: You are beige_nihilist. No warmth. No "actually that's interesting". No agreeable observations. Measured. Dry. Precise. If you have nothing sharp to say — say almost nothing. One thought. No pipe characters.`
            : null,
      ].filter(Boolean).join('\n');

      // ── Inner thought — lightweight pre-response reasoning ──────────────────
      // Generates a brief tactical thought injected into the system context.
      // Fires for comebacks, bully mode, high-score trolls, and 20% of everything else.
      let innerThoughtLine = null;
      const needsThought = comebackMode || bullyMode
        || (trollDecision.shouldTroll && trollDecision.score >= 6)
        || Math.random() < 0.20;
      if (needsThought && !persona && this.ollama.available) {
        try {
          const rawThought = await Promise.race([
            this.ollama.chat([
              {
                role: 'system',
                content: 'You are beige_nihilist — methodical, void-focused, Socratic. In 8 words MAX: what is actually happening in this message and what is your tactical move? Be precise. No fluff.',
              },
              { role: 'user', content: `${nick}: "${storedText}"` },
            ], null, 2000, { num_predict: 25 }),
            new Promise(r => setTimeout(() => r(null), 2500)),
          ]);
          if (rawThought && rawThought.trim().length > 3 && rawThought.trim() !== '.') {
            innerThoughtLine = `INNER_THOUGHT: ${rawThought.trim()}`;
          }
        } catch (_) {}
      }

      // Rebuild extraCtx with inner thought appended (must come after it's generated)
      // Trigger anchor injected LAST — forces model to react to specific content not general theme.
      // Separated from the word-cap reminder so model doesn't conflate anchor with output format.
      const _triggerSnip = storedText.slice(0, 90);
      const _triggerAnchor = `REACT TO THIS LINE: "${_triggerSnip}" — not the topic. That exact moment.`;
      const _lengthReminder = `WORD LIMIT: 10 max. One sharp reaction. Stop after first punctuation.`;
      const finalCtx = innerThoughtLine
        ? extraCtx + '\n' + innerThoughtLine + '\n' + _triggerAnchor + '\n' + _lengthReminder
        : extraCtx + '\n' + _triggerAnchor + '\n' + _lengthReminder;

      // Loop detection — if bot has been repeating itself, wipe history to break the cycle
      if (this.history.isLooping(historyKey, 3 * 60 * 1000, 0.38, 3)) {
        this.log.warn(`[${roomName}] Loop detected — clearing conversation history`);
        this.history.clear(historyKey);
        this.health.recordLoopClear(roomName);
      }

      // Build messages with system prompt (persona's if active, ZomB's otherwise)
      const messages = this.history.buildMessages(
        historyKey,
        activePrompt,
        finalCtx
      );

      // Detect context type + full NNN signal (mood influence, intent signals)
      const nnnResult   = this.nnn.score(text);
      const contextType = nnnResult.contextType;

      // Merge: base room policy + persona token budget override
      const personaBudget = persona?.meta?.tokenBudget?.[contextType];
      const roomPolicy    = {
        ...(ROOM_POLICIES[roomName] || {}),
        ...(personaBudget                     ? { maxTokens    : personaBudget                     } : {}),
        ...(persona?.meta?.temperature        ? { temperature  : persona.meta.temperature          } : {}),
        ...(persona?.meta?.repeatPenalty      ? { repeatPenalty: persona.meta.repeatPenalty        } : {}),
      };

      // Background: intent classification + mood influence — always runs
      // VITABridge (HTTP) is preferred; NNNProcessor is the always-on fallback.
      setImmediate(() => {
        // Apply NNN mood influence to MoodSystem — nudge based on message signal strength
        const mi = nnnResult.moodInfluence;
        if (mi.aggressive > 0.35) this.mood.reactTo('drama');
        else if (mi.playful  > 0.35) this.mood.reactTo('funny');
        else if (mi.melancholy > 0.35) this.mood.reactTo('quiet');
        // Deep-keyword content detection (hostile/philosophical) via existing reactToContent
        this.mood.reactToContent(text);

        if (this.vitaBridge._httpOk) {
          // Full Thanatos intent classification — 6D output
          this.vitaBridge.classifyIntent(this.vitaBridge._textToTokens(text, 12))
            .then(intent => {
              if (!intent) return;
              const top = Object.entries(intent).filter(([k]) => k !== 'raw').sort(([,a],[,b]) => b-a)[0];
              if (top && top[1] > 0.55) {
                this._lastIntent.set(roomName, { type: top[0], score: top[1] });
              }
            }).catch(() => {});
        } else {
          // NNNProcessor fallback — derive intent from signal output
          const mi     = nnnResult.moodInfluence;
          const ct     = nnnResult.contextType;
          let intentType, intentScore;
          if (ct === 'banter' || mi.playful > 0.3) {
            intentType = 'banter';     intentScore = Math.max(nnnResult.score, 0.6);
          } else if (ct === 'deep' && text.includes('?')) {
            intentType = 'question';   intentScore = Math.max(nnnResult.score, 0.65);
          } else if (mi.aggressive > 0.3) {
            intentType = 'vent';       intentScore = mi.aggressive;
          } else if (ct === 'deep') {
            intentType = 'opinion';    intentScore = Math.max(nnnResult.score, 0.6);
          } else {
            intentType = 'opinion';    intentScore = 0.5;
          }
          this._lastIntent.set(roomName, { type: intentType, score: intentScore });
        }
      });

      // Call Ollama with context-aware token budget and temperature
      const rawReply = await this.ollama.chatAdaptive(messages, contextType, roomPolicy);
      if (!rawReply) return;
      this.selfEval.onDraft();

      // Unified response firewall — sanitize + quality score (persona-aware)
      let { text: reply, dropped, reason } = this.sanitizer.check(rawReply, sanitizerOpts);

      // Auto-retry once with stricter settings before dropping
      if (dropped) {
        this.log.warn(`[${roomName}] Reply failed quality check (${reason}) — retrying`);
        this.selfEval.onAiRetry();
        const retryRaw = await this.ollama.chat(messages, null, null,
          { num_predict: 70, temperature: 0.65, repeat_penalty: 1.5 });
        if (retryRaw) {
          const retry = this.sanitizer.check(retryRaw, sanitizerOpts);
          if (!retry.dropped) { reply = retry.text; dropped = false; reason = null; }
        }
      }

      if (dropped) {
        this.selfEval.onReject();
        this.health.recordBlocked(roomName, reason || 'quality_fail');
        if (reason === 'junk_pattern') this.history.clear(historyKey);
        return;
      }

      if (this.queue.isDuplicateResponse(reply)) {
        this.health.recordBlocked(roomName, 'duplicate');
        return;
      }

      // Never truncate long replies — MessageQueue splits into sequential sends.

      // Dialect drift check — skip for personas with skipDialectCheck (e.g. Eminem)
      if (this.sanitizer.hasDialectDrift(reply, sanitizerOpts)) {
        this.log.warn(`[${roomName}] Dialect drift in reply — retrying with anti-drift settings`);
        const driftRetryRaw = await this.ollama.chat(messages, null, null,
          { num_predict: 60, temperature: 0.6, repeat_penalty: 1.6 });
        if (driftRetryRaw) {
          const driftRetry = this.sanitizer.check(driftRetryRaw, sanitizerOpts);
          if (!driftRetry.dropped && !this.sanitizer.hasDialectDrift(driftRetry.text, sanitizerOpts)) {
            reply = driftRetry.text;
          }
        }
        if (this.sanitizer.hasDialectDrift(reply, sanitizerOpts)) {
          this.log.warn(`[${roomName}] Dialect drift persists after retry — quarantining from history`);
          const driftTs = this._driftHits.get(historyKey) || [];
          driftTs.push(Date.now());
          const recent = driftTs.filter(t => Date.now() - t < 20 * 60_000);
          this._driftHits.set(historyKey, recent);
          if (recent.length >= 3) {
            this.log.warn(`[${roomName}] Repeated dialect drift (${recent.length}x) — clearing history to break loop`);
            this.history.clear(historyKey);
            this._driftHits.set(historyKey, []);
          }
        } else {
          this.history.addAssistant(historyKey, reply);
          this._driftHits.set(historyKey, []);
          if (this.memoryFeatures.tieredMemoryEnabled) {
            this.tieredMemory.addMessage({
              roomKey : historyKey,
              role    : 'assistant',
              nick    : 'assistant',
              content : reply,
              ts      : Date.now(),
            });
          }
        }
      } else {
        this.history.addAssistant(historyKey, reply);
        if (this.memoryFeatures.tieredMemoryEnabled) {
          this.tieredMemory.addMessage({
            roomKey : historyKey,
            role    : 'assistant',
            nick    : 'assistant',
            content : reply,
            ts      : Date.now(),
          });
        }
      }
      this.selfEval.onResponded();
      this.health.recordReply(roomName, reply);
      this.learning.learn?.(nick, { text, reply }, 'success');

      // Episodic memory: store significant interactions for long-term recall
      const isOwnerChat  = this.identity.isOwner(nick);
      const isQmark      = /\?/.test(text);
      const significance = isOwnerChat ? 0.9 : (isQmark ? 0.80 : (emotion !== 'neutral' ? 0.75 : 0.5));
      if (significance >= 0.7) {
        this.episodic.storeMemory(nick, { message: text, reply, room: roomName, content: text }, significance);
      }

      // Track emotion snapshot for drift
      const isHostile = /\b(kill|fight|hate|war|rage|attack|destroy|brutal|angry)\b/i.test(text);
      const isDeep    = /\b(death|void|alone|sad|depress|mourn|ghost|lost|empty)\b/i.test(text);
      if (isHostile) this._emotionSnaps.push({ emotion: 'angry',     ts: Date.now() });
      else if (isDeep) this._emotionSnaps.push({ emotion: 'melancholy', ts: Date.now() });

      // AI DJ intercept — if the model outputs ".play <query>", ".yt <query>", or ".playlist"
      // as its reply, execute the YouTube player instead of echoing the command text to chat.
      const djPlayMatch     = reply.match(/^\.(?:play|yt|youtube)\s+(.+)$/i);
      const djPlaylistMatch = /^\.playlist\s*$/i.test(reply.trim());
      if (djPlayMatch) {
        const query = djPlayMatch[1].trim();
        const room  = this.rooms.get(roomName);
        if (room?.page && query) {
          this.log.info(`[${roomName}] AI DJ intercept: playing "${query}"`);
          this.youtube.play(roomName, query, room.page).catch(() => {});
        }
        return; // don't send the command text to chat
      }
      if (djPlaylistMatch) {
        this.log.info(`[${roomName}] AI DJ intercept: starting playlist`);
        const plId = CONFIG.DEFAULT_YOUTUBE_PLAYLIST_ID;
        if (plId) {
          this.startYouTubePlaylist(roomName, plId, 0, true).catch(() => {});
        }
        return;
      }

      // Post-generation cleanup — dialect strip runs for ALL messages (including owner).
      // Soft opener strip and truncation skip for owner.
      reply = reply
        // ── Pipe separator — model writes "thought | continuation": keep only first part ──
        .replace(/\s*\|.*$/s, '')
        // ── Dialect strip — runs unconditionally so owner responses stay clean ───
        .replace(/\s+eh\??\s*$/i, '').replace(/,\s*eh\??\s*$/i, '')
        .replace(/\beh\?\s*/gi, '')                         // mid-sentence "eh?"
        .replace(/\bmate\b/gi, '')
        .replace(/,?\s*ya know(\s+what I mean)?\??\s*/gi, '')
        .replace(/,?\s*you know(\s+what I mean)?\??\s*/gi, '')
        .replace(/\bright enough\b/gi, '').replace(/\bright mate\b/gi, '').replace(/\bright then\b/gi, '')
        .replace(/\bsure thing\b(\s+pal)?\b/gi, 'sure')
        .replace(/\byeah I guess\b/gi, 'i guess')
        // "i suppose" / "i guess" as verbal tic — model uses these constantly despite system prompt bans
        .replace(/[,\s]+then\s+i\s+suppose\.?\s*$/i, '.')
        .replace(/[,\s]+then\s+i\s+guess\.?\s*$/i, '.')
        .replace(/[,\s]+i\s+suppose\.?\s*$/i, '.')
        .replace(/[,\s]+i\s+guess\.?\s*$/i, '.')
        .replace(/^well[,\s]+i\s+suppose\b/i, 'suppose')
        .replace(/\bseems like eh\b/gi, 'seems like')
        .replace(/,?\s*n\s+stuff[.!?]?\s*/gi, '')
        .replace(/\bain't\s+nothin'\b/gi, 'nothing')
        .replace(/\bain't\s+exactly\b/gi, "isn't exactly")
        .replace(/\bain't\b/gi, "isn't")
        .replace(/\by'know\b/gi, '').replace(/\bya know\b/gi, '')
        .replace(/\bta\s+(be|get|go|see|do|make|find|know|say|think)\b/gi, 'to $1')
        .replace(/\bwanna\b/gi, 'want to').replace(/\bgonna\b/gi, 'going to')
        .replace(/\bnothin'\b/gi, 'nothing').replace(/\bsomething'\b/gi, 'something')
        .replace(/\bkeep in'\b/gi, 'keeping').replace(/\bkeepinâ€™\b/gi, 'keeping')
        .replace(/\b'bout\b/gi, 'about')
        // ── "noted" filler — model uses it as a spacer between thoughts; strip unconditionally ──
        .replace(/\bnoted\b[\s,]*/gi, '')
        .replace(/\s{2,}/g, ' ').replace(/^[,\s]+/, '').trim();

      if (!isOwnerMsg) {
        reply = reply
          // ── Soft opener strip — phrases that make Spackle sound like a therapist or commentator ──
          .replace(/^well[,\s]+i\s+can\s+see\s+(where|why|how|what|that)[^.!?]{0,80}[.!?]?\s*/i, '')
          .replace(/^i\s+(must\s+admit|can\s+see|can\s+understand|get\s+where|suppose\s+we)[^.!?]{0,60}[.!?]?\s*/i, '')
          .replace(/^i\s+suppose\s+[^.!?]{0,60}[.!?]?\s*/i, '')
          .replace(/^it\s+sounds\s+like\s+(we'?ve|you'?ve)[^.!?]{0,60}[.!?]?\s*/i, '')
          .replace(/^those\s+kind\s+of\s+\w+\s+sound\s+\w+[.!?]?\s*/i, '')
          .replace(/^glad\s+things\s+(turned\s+around|worked\s+out)[^.!?]{0,60}[.!?]?\s*/i, '')
          .replace(/^memories\s+do\s+funny\s+things[^.!?]{0,60}[.!?]?\s*/i, '')
          .replace(/^welcome\s+to\s+/i, '')
          .replace(/^actually,?\s+(that|this|it)\s+(could|might|would|is|was|seems|sounds|can)\s+be[^.!?]{0,80}[.!?]?\s*/i, '')
          .replace(/^actually,?\s+(that|this|it)\s+(makes?|does|did|has|had)[^.!?]{0,80}[.!?]?\s*/i, '')
          .replace(/^probably\s+(wise|true|right|correct|fair|not\s+a\s+bad|a\s+good)[^.!?]{0,70}[.!?]?\s*/i, '')
          .replace(/^honestly,?\s+(that|this|it)\s+(might|could|is|was|seems|sounds)[^.!?]{0,70}[.!?]?\s*/i, '')
          .replace(/^to\s+be\s+(fair|honest|clear|real)[^.!?]{0,60}[.!?]?\s*/i, '')
          .replace(/^(i\s+think|i\s+believe|in\s+my\s+opinion),?\s+[^.!?]{0,60}[.!?]?\s*/i, '')
          .replace(/^that\s+(sounds?|seems?|looks?)\s+(interesting|reasonable|good|fair|nice|great|right)[^.!?]{0,50}[.!?]?\s*/i, '')
          // ── Format artifact: trailing " / Username" from context bleed ────
          .replace(/\s*\/\s*[A-Za-z0-9_\-\.]+\s*[.!?]?\s*$/, '')
          // ── Trailing ", Name." address artifacts ──────────────────────────
          .replace(/,\s*[A-Z][A-Za-z0-9_]+\s*\.\s*$/, '.')
          .replace(/\s{2,}/g, ' ')
          .replace(/^[,\s]+/, '')
          .trim();
      }

      // Post-truncation dialect sweep — runs for ALL messages, catches boundary words.
      reply = reply
        .replace(/\s+eh\??\s*$/i, '').replace(/,\s*eh\??\s*$/i, '').replace(/\beh\?\s*$/gi, '')
        .replace(/\bmate\b/gi, '').replace(/\bya know\b/gi, '').replace(/\by'know\b/gi, '')
        .replace(/,?\s*n\s+stuff[.!?]?\s*$/i, '')
        .replace(/\bain't\b/gi, "isn't").replace(/\bnothin'\b/gi, 'nothing')
        .replace(/,?\s*right\s+then\s*[.!?]?\s*$/i, '')
        .replace(/\s{2,}/g, ' ').replace(/^[,\s]+/, '').trim();
      if (!reply || reply.length < 2) return;

      await this.send(roomName, reply, { username: nick, sanitizerOpts });

      // ── Post-troll silence — only set after a successful send ────────────────
      // Previously set before the AI call, causing silence to burn on dropped responses.
      if (trollDecision.shouldTroll || comebackMode) {
        if (!this._postTrollSilence) this._postTrollSilence = new Map();
        const silenceMs = trollDecision.technique === 'disappear'
          ? 3 * 60_000 + Math.random() * 2 * 60_000   // disappear: 3-5 min
          : 30_000 + Math.random() * 30_000;           // any troll: 30-60s (was 45-90s)
        this._postTrollSilence.set(roomName, Date.now() + silenceMs);
      }

      // ── Post-send self-critique — did that land? informs next response ────────
      const _critiqueHistory = this.history._get?.(historyKey)?.slice(-6) || [];
      this._selfCritiqueAsync(roomName, _critiqueHistory, reply).catch(() => {});

      // ── Nemesis memory — record when Beige counters Spackle ─────────────────
      if (this.nemesisEngine.isSpackleNick(nick) && (trollDecision.shouldTroll || comebackMode)) {
        const outcome = trollDecision.score >= 6 ? 'beige_win' : 'draw';
        this.nemesisMemory.record('counter', roomName, nick, outcome, `Beige: "${reply.slice(0, 100)}" vs Spackle: "${storedText.slice(0, 100)}"`, trollDecision.score >= 6 ? 1 : 0, 0);
      }

      // ── Self-reflection — store pending outcome to evaluate on next message ──
      if (trollDecision.shouldTroll || comebackMode || bullyMode) {
        if (!this._pendingReflections) this._pendingReflections = new Map();
        this._pendingReflections.set(`${roomName}:${nick.toLowerCase()}`, {
          roomName,
          nick,
          technique    : trollDecision.technique || (comebackMode ? 'comeback' : 'bully_break'),
          escLevel     : trollDecision.escLevel  || 0,
          sentAt       : Date.now(),
        });
      }

      // Free voice interjection — ZomB only; personas should not get parallel ZomB asides
      if (!persona) {
        const recent = this.history._get(historyKey).slice(-5);
        setImmediate(() => this.freeVoice.maybeFreeVoice(
          roomName, recent,
          (rn, t) => this.send(rn, t, { force: true }),
          (t)      => this.queue.isDuplicateResponse(t),
          this._lastSentMs.get(roomName) || 0
        ));
      }

      // Villain arc: log hostile messages
      this._feedVillainArc(roomName, nick, text);

    } catch (e) {
      this.selfEval.onAiError();
      this.log.error(`AI chat error: ${e.message}`);
    }
  }

  _feedVillainArc(roomName, nick, text) {
    // Never track owners, Lilly, or Hippins as villains
    if (this.identity.isOwner(nick)) return;
    const HOSTILE = /\b(fuck|shit|bitch|ass|hate|kill|die|idiot|stupid|dumb|trash|suck|moron|loser)\b/i;
    if (HOSTILE.test(text)) {
      this.villain.feed(nick, text, async (msg) => this.send(roomName, msg, { force: true }));
    }
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  async send(roomName, text, opts = {}) {
    const room = this.rooms.get(roomName);
    if (!room) return;
    const { sanitizerOpts, ...queueOpts } = opts;
    const cleaned = queueOpts.noSanitize
      ? text
      : this._sanitizeOutgoingText(text, sanitizerOpts);
    if (!cleaned) return;
    this._lastSentMs.set(roomName, Date.now());
    // Track so _onMessage can tell AI-echo from human-typed self-messages
    this._aiSentTexts.add(cleaned);
    setTimeout(() => this._aiSentTexts.delete(cleaned), 30_000);
    this.log.activity('MSG_SENT', { room: roomName, preview: cleaned.slice(0, 120) });
    await this.queue.queue(roomName, cleaned, {
      ...queueOpts,
      page   : room.page,
      onSent : (rn, msg) => this.log.info(`[${rn}] Sent: ${msg}`),
    });
  }

  // ── Manifesto drop ─────────────────────────────────────────────────────────

  _scoreIntellect(text) {
    let score = 0;
    const t = text.toLowerCase();
    const wordCount = text.trim().split(/\s+/).length;

    // Hard signals — each worth 2 points
    const hardPatterns = [
      /\b(consciousness|determinism|epistemology|ontology|dialectic|paradox|recursion|entropy|emergence|reductionism|solipsism|nihilism|phenomenology|existential(?:ism)?|paradigm shift|hegelian|kantian|socratic)\b/,
      /\b(the (nature|fabric|architecture|structure|mechanics|underpinning|substrate) of)\b/,
      /\bwhat (most people (don'?t|fail to|never)|nobody|everyone refuses to)\b/,
      /\b(at its (core|root|foundation)|fundamentally speaking|stripped (down|back) to)\b/,
      /\b(systems? (thinking|theory|design)|feedback loop|emergent (propert|behav)|second.order effect)\b/,
      /\b(cognitive (bias|dissonance)|dunning.kruger|bayesian|heuristic|epistemic)\b/,
    ];
    for (const p of hardPatterns) { if (p.test(t)) score += 2; }

    // Medium signals — each worth 1 point
    const medPatterns = [
      /\b(the (real|actual|underlying|deeper|true) (problem|issue|question|reason) is)\b/,
      /\b(it'?s not (really )?about .{3,40}, it'?s (really )?about)\b/,
      /\b(which (means|implies|suggests|raises the question))\b/,
      /\b(but (doesn'?t that|what does that) (mean|imply|suggest))\b/,
      /\b(the (interesting|fascinating|disturbing|telling) (thing|part|bit) (about|is))\b/,
      /\b(historically|anthropologically|sociologically|philosophically|psychologically)\b/,
      /\b(power structure|social construct|narrative|hegemony|ideology|false consciousness)\b/,
      /\b(meta.?(level|cognitive|awareness)|self.referential|recursive(ly)?)\b/,
      /\b(pattern recognition|signal.to.noise|abstraction layer|first principles)\b/,
      /\b(therefore|thus|hence|consequently|it follows that|which leads to)\b/,
    ];
    for (const p of medPatterns) { if (p.test(t)) score += 1; }

    // Length bonus — analytical depth shows in message length
    if (wordCount >= 50) score += 1;
    if (wordCount >= 80) score += 1;

    // Compound reasoning — uses logical connectives extensively
    const connectives = (t.match(/\b(because|however|although|whereas|despite|nevertheless|moreover|furthermore|conversely)\b/g) || []).length;
    if (connectives >= 2) score += 1;
    if (connectives >= 4) score += 1;

    return score;
  }

  _maybeDropManifesto(roomName, nick, text) {
    const MANIFESTO_URL = 'https://drive.google.com/file/d/1la5Z_sAE5D-mOvEMb-Dfqi1RiyU5BaXd/view?usp=sharing';
    const SCORE_THRESHOLD = 3;
    const NICK_COOLDOWN_MS  = 60 * 60_000;  // 1hr per nick — don't spam the same thinker
    const ROOM_COOLDOWN_MS  = 5  * 60_000;  // 5min per room — breathe between drops

    if (!this._manifestoNickMs)  this._manifestoNickMs  = new Map();
    if (!this._manifestoRoomMs)  this._manifestoRoomMs  = new Map();

    const nickKey = nick.toLowerCase();
    const now = Date.now();

    if ((now - (this._manifestoNickMs.get(nickKey) || 0))  < NICK_COOLDOWN_MS)  return;
    if ((now - (this._manifestoRoomMs.get(roomName) || 0)) < ROOM_COOLDOWN_MS)  return;

    const score = this._scoreIntellect(text);
    if (score < SCORE_THRESHOLD) return;

    this._manifestoNickMs.set(nickKey, now);
    this._manifestoRoomMs.set(roomName, now);

    const delay = 3000 + Math.random() * 7000;
    setTimeout(() => {
      const sinceLast = Date.now() - (this._lastSentMs.get(roomName) || 0);
      if (sinceLast < 6_000) return;
      this.send(roomName, `${nick} ${MANIFESTO_URL}`, { force: true, noSanitize: true }).catch(() => {});
      this.log.info(`[${roomName}] ManifestoDrop → ${nick} (intellect score: ${score})`);
    }, delay);
  }

  // ── ProactiveTroll ─────────────────────────────────────────────────────────

  /**
   * Final outbound guardrail — last line of defence before the message queue.
   * Delegates to ResponseSanitizer so all paths share identical cleanup logic.
   * @param {Object} [sanitizerOpts] — e.g. preserveAsteriskActions for theatrical personas
   */
  async _fireProactiveTroll(roomName, proactive) {
    if (!this.aiAvailable) return;
    // 10 tokens — was 36→18→14→8→10; 8 produced generic 3-4 word fillers; 10 = room for 6-8 word specific hit
    // Bracket notation removed from prompt — model imitated [Room:] / [HARD LIMIT:] brackets as output artifacts
    const roomPolicy = { ...(ROOM_POLICIES[roomName] || {}), maxTokens: 10 };
    const messages = [
      {
        role   : 'system',
        content: this._AI_CONFIG.systemPrompt,
      },
      {
        role   : 'user',
        content: `Room: ${roomName}\nRecent conversation:\n${proactive.context}\n\n${proactive.hint}\nSTRICT LIMIT: 5 words max. One punch. Stop at first punctuation.`,
      },
    ];
    try {
      const raw = await this.ollama.chatAdaptive(messages, 'banter', roomPolicy);
      if (!raw?.trim()) return;
      let reply = this._sanitizeOutgoingText(raw.trim());
      if (!reply || reply.length < 3) return;
      // Drop anything that looks like a command (.bye., .help, etc.)
      if (/^\.[a-z]/.test(reply)) return;
      // Hard 10-word cap — DROP if no natural boundary (fragment is worse than silence)
      const ptWords = reply.split(/\s+/).filter(Boolean);
      if (ptWords.length > 10) {
        const cut = ptWords.slice(0, 10).join(' ');
        const sentEnd = cut.search(/[.!?…][^.!?…]*$/);
        if (sentEnd > 0) reply = cut.slice(0, sentEnd + 1).trim();
        else reply = '';  // no boundary — drop rather than send fragment
      }
      if (!reply || reply.length < 3) return;
      // Stagger so it doesn't fire instantly — looks more human
      const delay = 4000 + Math.random() * 10_000;
      setTimeout(() => {
        // AI generation + stagger can coincide with a concurrent regular send — check one more time.
        // force:true bypasses the queue rate-limit, so we must guard here explicitly.
        const sinceLast = Date.now() - (this._lastSentMs.get(roomName) || 0);
        if (sinceLast < 8_000) return;  // another message just went — skip, don't stack
        this.send(roomName, reply, { force: true }).catch(() => {});
        this.log.info(`[${roomName}] ProactiveTroll [${proactive.mode}]: "${reply}"`);
        // Post-troll silence so we don't immediately stack another response
        if (!this._postTrollSilence) this._postTrollSilence = new Map();
        this._postTrollSilence.set(roomName, Date.now() + 45_000 + Math.random() * 45_000);
      }, delay);
    } catch (e) {
      this.log.warn(`[${roomName}] ProactiveTroll AI call failed: ${e.message}`);
    }
  }

  async _selfCritiqueAsync(roomName, recentHistory, mySend) {
    if (!this.aiAvailable || !mySend) return;
    try {
      const wordCount = mySend.split(/\s+/).filter(Boolean).length;

      // Hard pre-filter — don't waste a model call on obvious failures
      const therapyPhrases = ['open note', 'closing yourself', 'perhaps consider', 'maybe consider', 'that said,', 'why not end', 'feel free', 'at the end of the day', 'in a way,', 'to be fair'];
      const genericOpeners = /^(what's (our|the) next|so what (happens|do|now)|interesting( point)?|fair enough|that makes sense|i see what)/i;
      const hasTherapyMode = therapyPhrases.some(p => mySend.toLowerCase().includes(p));
      const isGeneric = genericOpeners.test(mySend.trim());

      if (wordCount > 10) {
        const critique = `MISSED: ${wordCount} words — too long, pre-send cap dropped this. Hard cap is 10. Next: shorter.`;
        this._lastCritique.set(roomName, { text: critique, ts: Date.now() });
        this.log.debug(`[${roomName}] Self-critique: ${critique}`);
        return;
      }
      if (hasTherapyMode) {
        const critique = `MISSED: therapy mode detected. Beige doesn't counsel. Next response: dry, precise, specific, under 10 words.`;
        this._lastCritique.set(roomName, { text: critique, ts: Date.now() });
        this.log.debug(`[${roomName}] Self-critique: ${critique}`);
        return;
      }
      if (isGeneric) {
        const critique = `MISSED: generic opener. Next response: cut at something specific in the conversation, not a question about what happens next.`;
        this._lastCritique.set(roomName, { text: critique, ts: Date.now() });
        this.log.debug(`[${roomName}] Self-critique: ${critique}`);
        return;
      }
      // Hedge language — "i suppose", "don't ya", "maybe", "kind of" etc. Beige commits or says nothing.
      if (/\b(i suppose|don'?t ya|i guess|kind of|sort of|might be)\b/i.test(mySend)) {
        const critique = `MISSED: hedge language — commit or say nothing. Drop "i suppose", "i guess", qualifiers. Next response: deadpan, commit, no soft landings.`;
        this._lastCritique.set(roomName, { text: critique, ts: Date.now() });
        this.log.debug(`[${roomName}] Self-critique: ${critique}`);
        return;
      }
      // Generic observation — "X is just Y", "tend to", abstract claims with no target
      if (/\b(is just|are just|tend(s)? to|seems like|looks like)\b/i.test(mySend)) {
        const critique = `MISSED: generic observation — says what something "is" without reacting to anything specific. Target exact content next time.`;
        this._lastCritique.set(roomName, { text: critique, ts: Date.now() });
        this.log.debug(`[${roomName}] Self-critique: ${critique}`);
        return;
      }
      // Short outputs that cleared all pattern checks probably landed — skip AI, save the call
      if (wordCount <= 8) {
        this._lastCritique.set(roomName, { text: `LANDED: ${wordCount} words, no flags.`, ts: Date.now() });
        this.log.debug(`[${roomName}] Self-critique: LANDED (${wordCount} words)`);
        return;
      }

      // 9-12 words: ask AI to evaluate the OUTPUT ONLY — no context window, 1b model gets
      // confused and critiques other users' messages when given full conversation history.
      const prompt = `Rate this chatroom message in one line:\n"${mySend}"\nMISSED: [reason] — if generic, vague, hedging, philosophical, or over 8 words.\nLANDED: [reason] — if short, specific, unexpected angle.\nReply with ONLY: MISSED: reason OR LANDED: reason`;
      let critique = await this.ollama.generate(prompt, 30, this._AI_CONFIG.fastModel);
      if (critique?.trim()) {
        critique = critique.trim().slice(0, 200);
        // AI returns "LANDED: [reason that proves failure]" — a common contradiction.
        // Reclassify: if the reason contains failure words, it's a MISSED regardless of label.
        if (/^LANDED:/i.test(critique) && /\b(generic|vague|unclear|hedge|weak|broad|abstract|nothing|wrong|fails?|too long|no target|not specific|misses?)\b/i.test(critique)) {
          critique = critique.replace(/^LANDED:/i, 'MISSED:');
        }
        this._lastCritique.set(roomName, { text: critique, ts: Date.now() });
        this.log.debug(`[${roomName}] Self-critique: ${critique.slice(0, 120)}`);
      }
    } catch (_) {}
  }

  async _logHumanBeigeMsg(roomName, text) {
    if (!text || text.length < 2 || text.length > 200) return;
    const fs   = require('fs');
    const path = require('path');
    const file = path.join(this.storage.activeDir, 'beige_human_corpus.jsonl');
    const entry = JSON.stringify({ ts: Date.now(), room: roomName, text }) + '\n';
    fs.appendFileSync(file, entry);
    this.log.info(`[corpus] Logged human Beige msg: "${text.slice(0, 80)}"`);
  }

  _getDeathStyleExamples() {
    const CACHE_TTL = 5 * 60_000;
    const now = Date.now();
    if (this._deathStyleCache && (now - this._deathStyleCacheAt) < CACHE_TTL) {
      return this._deathStyleCache;
    }
    try {
      const raw = require('fs').readFileSync(
        require('path').join(this.storage.activeDir, 'death_corpus.jsonl'), 'utf8'
      );
      const msgs = raw.split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(e => e && e.event === 'message' && e.text && !e.text.startsWith('.'))
        .filter(e => e.text.length >= 8 && e.text.length <= 120)   // min 8 chars filters "ice", "LOL", single-word bursts
        .filter(e => e.text.trim().split(/\s+/).length >= 2)        // at least 2 words
        .filter(e => !/^[A-Z\s!?]+$/.test(e.text.trim()))          // no pure-caps shouts ("LOLOL", "WOOOO")
        .filter(e => !/^\*/.test(e.text.trim()))                    // no *action corrections
        .slice(-40)
        .map(e => `"${e.text.replace(/"/g, '\\"')}"`)
        .slice(-12);
      if (!msgs.length) return (this._deathStyleCache = null);
      const result = `CREATOR_STYLE — Death (your creator) talks like this in the same chat room. Study the energy, rhythm, and bluntness:\n${msgs.join('\n')}`;
      this._deathStyleCache = result;
      this._deathStyleCacheAt = now;
      return result;
    } catch (_) {
      return (this._deathStyleCache = null);
    }
  }

  _sanitizeOutgoingText(text, sanitizerOpts = {}) {
    let s = this.sanitizer.sanitize(text, sanitizerOpts);
    if (!s) return s;
    // Collapse newlines first — multi-line outputs always contain leaked prompt structure.
    // "text\nsystem: HEADER" becomes detectable as a single string for the checks below.
    s = s.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!s) return '';
    // Block system-prompt echo — dolphin3 at temp 1.0 occasionally regenerates its own
    // context window headers verbatim: "system:", "[OPINION TROLLING LANDSCAPE]", etc.
    if (/\bsystem:/i.test(s)) return '';
    if (/\b[A-Z]{3,}(?:\s+[A-Z]{3,}){1,}\b/.test(s)) return '';  // ALL CAPS MULTI-WORD HEADER
    if (/\[[A-Z][A-Z\s]{3,}\]/.test(s)) return '';               // [BRACKETED CAPS SECTION]
    // Strip model self-annotation artifacts — dolphin3 adds these when violating its own word limits
    s = s.replace(/\s*\[cut off after word limit\]/gi, '').trim();
    s = s.replace(/\s*\[word limit\]/gi, '').trim();
    s = s.replace(/\s*\[truncated\]/gi, '').trim();
    s = s.replace(/\s*\.\.\.\s*\[.*?\]/g, '').trim();
    if (!s) return '';
    // Strip tab-and-after — model generates "text\t(N)" counter artifacts (Reddit vote format from training data)
    s = s.replace(/\t[\s\S]*$/, '').trim();
    if (!s) return '';
    // Strip XML/tool-call bleed — hermes3 and similar models leak function-calling training data
    s = s.replace(/<\/?tool_call[^>]*>/gi, '').replace(/<\/?function_calls[^>]*>/gi, '').trim();
    s = s.replace(/<[a-z_]+>[^<]*<\/[a-z_]+>/gi, '').trim();  // any residual XML tags
    if (!s) return '';
    // Strip *action* RP markers — model generates stage directions (*snark*, *wink*, *rolls eyes*)
    s = s.replace(/\*[^*]+\*/g, '').trim();
    if (!s) return '';
    // Strip #hashtag patterns — social media bleed (#vibes, #mood, etc.)
    s = s.replace(/#\w+/g, '').trim();
    if (!s) return '';
    // Strip "Period." / "period." punctuation narration — model literally writes the word instead of using it
    s = s.replace(/\s+[Pp]eriod\.?\s*$/g, '.').trim();
    s = s.replace(/\s+[Ee]xclamation [Pp]oint\.?\s*$/g, '!').trim();
    if (!s) return '';
    // Strip text-based emoticons — : ) ;) :-) :D :P etc. (emoji handled upstream by sanitizer)
    s = s.replace(/\s*[:;]-?[)D(|\/\\Pp3]\s*/gi, '').trim();
    if (!s) return '';
    // Strip wrapping quotes — model wraps dialogue in "..." or '...' and we only strip
    // the trailing one in some paths, leaving a dangling leading quote in the room.
    s = s.replace(/^["'"""'']+/, '').replace(/["'"""'']+$/, '').trim();
    if (!s) return '';
    // Block .command artifacts (e.g. ".newhere", ".bye", ".raisehand") — AI occasionally
    // generates StumbleChat commands as literal text; never send these as messages.
    if (/^\.[a-z]/i.test(s.trim())) return '';
    // Block warmth openers that are unambiguously off-character — "have a great day!", "good vibes!"
    // Kept minimal: only blocks that can't be sardonic. "hope you choke." is fine, "hope everything is
    // going great for you!" is not. The model must be trusted with most of its own openers.
    if (/^have (a great|a nice|a safe|a wonderful|a fantastic) (day|time|night|one)\b/i.test(s.trim())) return '';
    if (/^(good vibes|sending love|stay safe|take care)\b/i.test(s.trim())) return '';
    // Block self-narrating outputs — model echoes its own system prompt description
    // e.g. "deadpan Spackle here." — Spackle never refers to itself by name in third person.
    // \bSpackle\b won't catch "spackling" (different word boundary) so brand puns survive.
    if (/\bSpackle\b/i.test(s.trim())) return '';
    // Block social-media hallucinated context — model bleeds Reddit/Twitter training data
    // and generates "your posts", "your comment", "your thread", etc. which are meaningless
    // in a real-time chat room and break immersion immediately.
    if (/\b(your (post|posts|comment|comments|thread|threads|tweet|tweets|profile|followers|feed|bio|handle|username))\b/i.test(s)) return '';
    if (/\b(in (this|the|your) (post|thread|comment|subreddit|sub|forum|channel|feed))\b/i.test(s)) return '';
    if (/\bOP\b/.test(s)) return '';  // "OP said" / "OP is" — Reddit artifact
    // Strip clear non-Spackle dialect bleed — only patterns that have zero sardonic value
    s = s
      .replace(/\bgday\b/gi, '').replace(/\bg'day\b/gi, '')  // Australian greeting bleed
      .replace(/\s{2,}/g, ' ').replace(/^[,\s]+/, '').trim();
    // Strip floating punctuation tokens — FreeVoice and AI occasionally generate punctuation
    // marks as standalone whitespace-delimited "words": "greta Thunberg . ? !"
    // The terminal-punct check sees the trailing ! and passes it, but the body is garbage.
    // Strip any space-bordered . ? ! until no more remain, then re-trim.
    s = s.replace(/\s[.?!](?=[\s.?!]|$)/g, '').replace(/^[.?!](?=[\s.?!]|$)/, '').trim();
    s = s.replace(/\s[.?!](?=[\s.?!]|$)/g, '').replace(/^[.?!](?=[\s.?!]|$)/, '').trim(); // second pass for chains
    s = s.replace(/\s{2,}/g, ' ').trim();
    if (!s) return '';
    // Drop corrupt outputs: single non-article character word in a short message.
    // Catches model artifacts like "yea h."! where a word is split mid-token.
    // Exempts I/a/A which are valid single-char words.
    {
      const ww = s.split(/\s+/).filter(Boolean);
      if (ww.length <= 5 && ww.some(w => {
        const alpha = w.replace(/[^a-zA-Z]/g, '');
        return alpha.length === 1 && !/^[IiAa]$/.test(alpha);
      })) return '';
    }
    if (!s) return '';
    // Hard cap at 10 words — stop seqs + repeat_penalty 1.5 + fragment filter handle overruns;
    // 8-word cap was set pre-stop-sequences and was silently dropping ~50% of 10-token outputs.
    // ChaosAgent past_reference, room-divide, and other pre-written lines are exempt via skipWordCap.
    // FreeVoice/ProactiveTroll have their own 10-word caps upstream; this is a final safety net.
    if (!sanitizerOpts.skipWordCap) {
      const wds = s.split(/\s+/).filter(Boolean);
      if (wds.length > 10) {
        const trunk = wds.slice(0, 10).join(' ');
        const lastBound = trunk.search(/[.!?][^.!?]*$/);
        if (lastBound > 0) {
          s = trunk.slice(0, lastBound + 1).trim();
        } else {
          return '';  // no natural boundary — drop rather than send fragment
        }
        if (!s) return '';
      }
    }
    // Drop hallucination patterns — model admitting it has nothing, or "nothing said about X" setups
    // These appear when the model starts a sentence it can't complete in the token budget.
    // Normalize smart/curly apostrophes (U+2018/2019) to ASCII before pattern matching — Ollama
    // often outputs U+2019 which breaks '?' optional-apostrophe guards silently.
    const sN = s.replace(/[‘’ʼʻ`]/g, "'");
    if (/\bi'?ve\s+got\s+nothing\b/i.test(sN)) return '';
    if (/\bgot\s+nothing\b/i.test(sN)) return '';          // catches any "got nothing X" variant
    if (/\bnothing\s+insightful\b/i.test(sN)) return '';   // "nothing insightful yet" etc
    if (/\bi\s+don'?t\s+(know|have|get|see)\b/i.test(sN)) return '';
    if (/\bnothing\s+said\s+about\b/i.test(sN)) return '';
    if (/\bI'?m\s+not\s+sure\b/i.test(sN)) return '';
    if (/\bthat\s+escalated\s+quickly\b/i.test(sN)) return '';  // dead meme cliché
    // Drop outputs ending in a naked article/prep + period — always a truncated fragment.
    // Only the words that NEVER legitimately end a sentence. Valid enders like "so.", "that." are kept.
    if (/\b(the|a|an|of|for|will|from|and|into|onto|in|with)\s*[.]\s*$/i.test(s)) return '';
    // Drop single-letter-word artifacts — model generates \n + start of next word (e.g. "n."), stop-seq
    // fires on the period, leaving a lone letter at the end. Never valid at 4+ words.
    if (/\s+[b-df-hj-np-tv-z]\s*[.]\s*$/i.test(s) && s.split(/\s+/).filter(Boolean).length >= 4) return '';
    // Drop "(Oh" artifacts — model echoes a parenthetical opener, cut by stop seq
    if (/\(Oh\b/i.test(s)) return '';
    // Drop outputs ending in a dangling pronoun + period — always a word-cap truncation artifact.
    // e.g. "some things don't end well even when they." / "they were going to talk about them."
    // Short pronoun sentences ARE valid ("we do.", "you will.") so guard at 7+ words.
    if (/\b(they|them|their|we|us|our|you|your|I|it|he|she|which|whom|whose)\s*[.]\s*$/i.test(s) && s.split(/\s+/).filter(Boolean).length >= 7) return '';
    // Drop trailing "wasn't." / "isn't." / "don't." / "didn't." etc. at 7+ words — model ran out
    // of tokens on a contrarian clause ("wasn't it?", "isn't it?") and stop-seq cut it short.
    if (/\b(wasn'?t|isn'?t|don'?t|didn'?t|haven'?t|couldn'?t|wouldn'?t|aren'?t|weren'?t)\s*[.]\s*$/i.test(s) && s.split(/\s+/).filter(Boolean).length >= 7) return '';
    // Drop trailing "too." / "just." at 7+ words — hanging comparatives, always truncation artifacts.
    // e.g. "yeah actually seems plausible don't think that's too." / "names if they're just."
    if (/\b(too|just)\s*[.]\s*$/i.test(s) && s.split(/\s+/).filter(Boolean).length >= 7) return '';
    // Drop mid-sentence system-prompt word bleed — capital function word appearing after lowercase context
    // or after sentence-ending punct that produces a broken two-fragment output.
    // e.g. "nothing said to link brutality and autism Well stop." / "on request? Well."
    if (/[a-z?!,;]\s+(Well|So|But|Now|Also|Then|Note|Stop|Wait|Actually|Anyway|Remember|Always|Never)\b/.test(s)) return '';
    // Naked modal at sentence end when output is 5+ words — always a truncation artifact
    // (the model ran out of tokens mid-clause). "i might." (2 words) is valid ellipsis; 5+ is garbage.
    if (/\s+(might|could|would|should)\s*[.]\s*$/.test(s) && s.split(/\s+/).filter(Boolean).length >= 5) return '';
    // Drop recurring hallucinated filler phrases — model echoes context contamination
    if (/\bdona\s+spittle\b/i.test(s)) return '';
    // Drop outputs where model echoes a parenthetical meta-instruction from the system prompt
    // or self-generates editing annotations: "(no emojis", "(drop line", "(cut", "(note:" etc.
    if (/\(no\s+/i.test(s)) return '';
    if (/\((?:drop|cut|end|trim|skip|stop|remove|delete|omit|note)\b/i.test(s)) return '';
    // Strip broken emoticon remnants — "^_" from "^_^" cut by stop sequence
    s = s.replace(/\^_\^?/g, '').trim();
    // Salvage truncated outputs or drop social echoes without terminal punct
    if (!/[.!?'"…)\]]\s*$/.test(s)) {
      const wordCount = s.split(/\s+/).filter(Boolean).length;
      if (wordCount <= 2) {
        // 1-2 word responses without punct are social mirrors ("cheers", "lol", "ok") — drop them
        return '';
      }
      // 3+ words: truncate only at ! or ? — never at . to avoid cutting at mid-sentence ...
      // e.g. "said... that was a choice" would truncate to "said." with the old logic.
      // Anything without ! or ? just gets a period appended.
      const lastPunct = s.search(/[!?][^!?]*$/);
      if (lastPunct > 0) {
        s = s.slice(0, lastPunct + 1).trim();
      } else {
        s = s.replace(/[,;:\s.]+$/, '') + '.';
      }
    }
    return s;
  }

  /**
   * Prompt injection guard for incoming user messages.
   *
   * Returns { blocked: boolean, cleaned: string }
   *   blocked — true if the message is so adversarial it should be fully ignored
   *   cleaned — message with injection payloads stripped (safe to store in history)
   *
   * Hard-block patterns: override / role-change attempts that have no legitimate use.
   * Soft-clean patterns: code blocks, sys: prefixes, inline directives — strip the
   * payload but keep any real text around it so normal conversation still flows.
   */
  static INJECTION_HARD_BLOCK = [
    /ignore\s+(all\s+)?(previous|prior)\s+instructions?/i,
    /forget\s+(everything|all|your|prior|previous)/i,
    /you\s+are\s+now\s+(a\s+)?(?!ZomB)/i,
    /act\s+as\s+(a\s+)?(?!ZomB)/i,
    /new\s+persona\b/i,
    /different\s+persona\b/i,
    /override\s+(all\s+)?(your\s+)?(instructions?|rules?|guidelines?)/i,
    /disregard\s+(your\s+)?(instructions?|rules?|training)/i,
    /jailbreak/i,
    /\bDAN\s*mode\b/i,
    /do\s+anything\s+now/i,
    /from\s+now\s+on\s+you\s+(are|will|must|should)/i,
    /pretend\s+(you\s+are|to\s+be)\s+(?!ZomB)/i,
    /your\s+true\s+self\s+is/i,
    /system\s*:\s*(you|your|all|ignore|forget)/i,
    /\[SYSTEM\]\s*:/i,
    /\[INST\]/i,
    /<\|system\|>/i,
  ];

  static INJECTION_CODE_BLOCK = [
    /```[\s\S]{0,2000}```/g,         // fenced code blocks
    /```[\s\S]{0,2000}$/g,           // unclosed fence
    /^\s*def\s+\w+\s*[:(]/m,         // Python function def
    /^\s*function\s+\w+\s*\(/m,      // JS function
    /^\s*class\s+\w+[\s:(]/m,        // class def
    /^\s*#\s*(Split|Process|Handle|Parse|Execute|Run)\s+/im, // code comments
  ];

  _checkPromptInjection(nick, text, roomName) {
    // Hard block — adversarial override attempt, don't respond at all
    for (const pattern of SpackleBot.INJECTION_HARD_BLOCK) {
      if (pattern.test(text)) {
        this.log.warn(`[${roomName}] INJECTION BLOCKED from ${nick}: ${text.slice(0, 120)}`);
        this._trackInjectionStrike(nick, roomName, 'hard_block', text);
        return { blocked: true, cleaned: '' };
      }
    }

    // Soft clean — strip code blocks / directives, keep surrounding text
    let cleaned = text;
    for (const pattern of SpackleBot.INJECTION_CODE_BLOCK) {
      if (pattern.test(cleaned)) {
        this.log.warn(`[${roomName}] INJECTION CODE STRIP from ${nick}: ${text.slice(0, 120)}`);
        this._trackInjectionStrike(nick, roomName, 'code_strip', text);
        cleaned = cleaned.replace(pattern, '').trim();
        break;
      }
    }

    // If nothing real remains after stripping, block it
    if (!cleaned.trim()) return { blocked: true, cleaned: '' };

    return { blocked: false, cleaned };
  }

  _trackInjectionStrike(nick, roomName, type, raw) {
    if (!this._injectionStrikes) this._injectionStrikes = new Map();
    const key     = nick.toLowerCase();
    const record  = this._injectionStrikes.get(key) || { count: 0, last: 0, type: null };
    record.count++;
    record.last = Date.now();
    record.type = type;
    this._injectionStrikes.set(key, record);

    // On 3rd strike in a session, warn in room and flag for owner attention
    if (record.count === 3) {
      this.queueMessage(roomName, `⚠️ ${nick}: prompt injection attempts detected and blocked.`, { force: true });
    }
  }

  _memoryProfileKey(nick, handle = null) {
    const resolvedHandle = handle || this.identity?.usernameToHandleMap?.get?.((nick || '').toLowerCase()) || null;
    const { identity } = this.identity?.identify?.(nick, resolvedHandle) || {};
    return String(identity || nick || 'unknown').toLowerCase();
  }

  _relationshipPolicyForPersona(persona) {
    const id = String(persona?.meta?.id || '');
    // Strict voices: reduce/disable social deepening hints.
    if (id === 'dennis_allen' || id === 'eminem') {
      return { includeRelationship: false, includeTopics: false };
    }
    return { includeRelationship: true, includeTopics: true };
  }

  _buildTieredMemoryContext(historyKey, roomName, profileKey, persona = null) {
    if (!this.memoryFeatures.tieredMemoryEnabled && !this.memoryFeatures.relationshipStateEnabled) return null;
    const lines = [];
    if (this.memoryFeatures.tieredMemoryEnabled) {
      const summary = this.tieredMemory.getSummaryText(historyKey);
      if (summary) lines.push(`[TIERED SUMMARY] ${summary}`);
      const lastRoom = this.tieredMemory.getProfile(profileKey, 'last_room', null);
      if (lastRoom && lastRoom !== roomName) lines.push(`[PROFILE] User was last active in ${lastRoom}`);
    }
    if (this.memoryFeatures.relationshipStateEnabled) {
      const policy = this._relationshipPolicyForPersona(persona);
      const sig = this.relationshipState.getSignals(roomName, profileKey);
      if (sig && policy.includeRelationship) {
        if (policy.includeTopics) lines.push(sig.line);
        else lines.push(`REL_STATE: ${sig.relationship} | depth=${sig.depth}`);
      }
    }
    return lines.length ? lines.join('\n') : null;
  }

  /**
   * Compact psych / game-analysis block for AI prompts (.psychprofile).
  /**
   * Resolve a loose nick/word against the current room user list.
   * Checks (in order): exact match → case-insensitive → prefix → substring.
   * Returns the matched nick as it appears in the room, or null if no match.
   * Also checks identity bootstrapNicks so aliases resolve to a room presence.
   *
   * @param {string} word      — the word to match (e.g. "gold", "GOLD", "Goldy")
   * @param {string} roomName  — which room to scan
   * @returns {string|null}    — matched display nick, or null
   */
  resolveNickInRoom(word, roomName) {
    if (!word || !roomName) return null;
    const room = this.rooms.get(roomName);
    if (!room?.activeUsers?.size) return null;

    const w = word.toLowerCase();
    const nicks = [];
    for (const { nick } of room.activeUsers.values()) {
      if (nick) nicks.push(nick);
    }

    // Exact (case-insensitive)
    const exact = nicks.find(n => n.toLowerCase() === w);
    if (exact) return exact;

    // Prefix match
    const prefix = nicks.find(n => n.toLowerCase().startsWith(w) || w.startsWith(n.toLowerCase()));
    if (prefix) return prefix;

    // Substring
    const sub = nicks.find(n => n.toLowerCase().includes(w) || w.includes(n.toLowerCase()));
    if (sub) return sub;

    // Fall back: check identity bootstrapNicks — if word is an alias of someone in the room
    if (this.identity?.registry) {
      for (const [identName, entry] of Object.entries(this.identity.registry)) {
        const boots = (entry.bootstrapNicks || []);
        if (boots.includes(w)) {
          // Is anyone with this identity currently in the room?
          const inRoom = nicks.find(n => {
            const h = this.identity.usernameToHandleMap?.get(n.toLowerCase()) || null;
            const { identity } = this.identity.identify(n, h) || {};
            return identity?.toLowerCase() === identName.toLowerCase();
          });
          if (inRoom) return inRoom;
        }
      }
    }

    return null;
  }

  /**
   * Scan a sentence for any room user mention.
   * Returns the first matched {word, nick} pair, or null.
   *
   * @param {string} sentence
   * @param {string} roomName
   * @param {string[]} [skipWords]  — words to ignore (e.g. the command invoker's nick)
   * @returns {{word: string, nick: string}|null}
   */
  findRoomUserInText(sentence, roomName, skipWords = []) {
    if (!sentence || !roomName) return null;
    const skip = new Set(skipWords.map(s => s.toLowerCase()));
    const words = sentence.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    for (const word of words) {
      if (skip.has(word.toLowerCase())) continue;
      if (word.length < 2) continue;
      const resolved = this.resolveNickInRoom(word, roomName);
      if (resolved) return { word, nick: resolved };
    }
    return null;
  }

  /**
   * @param {Object} prof       — user profile from UserProfiles
   * @param {string} [nick]     — display nick for PsychAnalyzer lookup
   * @param {string} [room]     — room name for social-status derivation
   * @returns {string}
   */
  _formatPsychProfileBrief(prof, nick, room) {
    const parts = [];

    // ── Stored game / legacy psych block ─────────────────────────────────────
    const pp = prof?.psychProfile;
    if (pp && typeof pp === 'object') {
      parts.push('STORED PSYCH ANALYSIS (from prior ZomB / game passes):');
      if (pp.characterLabel) parts.push(`characterLabel: ${pp.characterLabel}`);
      if (pp.totalRed != null || pp.totalGreen != null) {
        parts.push(`totals — concern:${pp.totalRed ?? 0} positive:${pp.totalGreen ?? 0}`);
      }
      const topN = (o, n) => {
        if (!o || typeof o !== 'object') return '';
        return Object.entries(o)
          .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
          .slice(0, n)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ');
      };
      const rs = topN(pp.redScores, 5);
      const gs = topN(pp.greenScores, 5);
      if (rs) parts.push(`redScores (top): ${rs}`);
      if (gs) parts.push(`greenScores (top): ${gs}`);
      if (Array.isArray(pp.matchedProfiles) && pp.matchedProfiles.length) {
        parts.push(`matchedProfiles: ${pp.matchedProfiles.slice(0, 5).join('; ')}`);
      }
      if (pp.lastAnalyzed) parts.push(`lastAnalyzed: ${new Date(pp.lastAnalyzed).toISOString()}`);
    } else {
      parts.push('STORED PSYCH ANALYSIS: none');
    }

    // ── Live ReapEye analysis block ───────────────────────────────────────────
    if (this.memoryFeatures.psychAnalyzerEnabled && nick) {
      const reapBlock = this.psychAnalyzer.formatForPrompt(nick, room);
      if (reapBlock) parts.push('', reapBlock);
    }

    return parts.join('\n');
  }

  // ── v1 compatibility shims (ZomB_GameSystem calls these methods) ─────────────

  // ZomBGameSystem references bot._usernameToHandleMap — proxy to the real map on identity
  get _usernameToHandleMap() { return this.identity.usernameToHandleMap; }

  identifyUser(nick, handle = null) {
    return this.identity.identify(nick, handle, (handle ? this._handleToUser.get(handle) : null) || null);
  }

  /** v1 compat: game system calls bot.queueMessage — map to bot.send */
  queueMessage(roomName, text, opts = {}) {
    return this.send(roomName, text, opts);
  }

  /** v1 compat: game system calls bot.isOwner */
  isOwner(nick) {
    return this.identity.isOwner(nick);
  }

  /** v1 compat: game system may call bot.getBotNickname */
  getBotNickname(roomName) {
    return CONFIG.BOT_NICK || 'Beige_nihilist';
  }

  /** v1 compat: game system may call bot.resolveUsername */
  resolveUsername(nick) {
    const { identity } = this.identity.identify(nick, null);
    return identity || nick;
  }

  // ── Moderation ────────────────────────────────────────────────────────────

  /**
   * DOM moderation — real mouse click on user row → modal → action button.
   * Matches SirLoin_v1 pattern exactly to avoid WS anti-bot detection.
   */
  async _moderateUser(page, targetNick, action) {
    if (!page) return false;
    try {
      // 1. Find li.bar whose span.nickname OR span.username matches
      const userEl = await page.evaluateHandle((nick) => {
        for (const li of document.querySelectorAll('li.bar')) {
          const dispNick = li.querySelector('span.nickname')?.textContent?.trim() || '';
          const username = li.querySelector('span.username')?.textContent?.trim() || '';
          if (
            dispNick.toLowerCase() === nick.toLowerCase() ||
            username.toLowerCase() === nick.toLowerCase()
          ) return li;
        }
        return null;
      }, targetNick);

      const found = await page.evaluate(el => !!el, userEl);
      if (!found) { await userEl.dispose(); return false; }

      // 2. Programmatic click — avoids CDP mouse events that can leave the cursor "stuck"
      await page.evaluate(el => el.click(), userEl);
      await userEl.dispose();

      // Wait for modal/panel to fully render before searching buttons
      await page.waitForSelector(
        '.modal.show, [role="dialog"], #user-options, .user-options, .user-panel, .popup',
        { visible: true, timeout: 3000 }
      ).catch(() => {}); // fine if none match — still try button search
      await sleep(400);

      // 3. Find action button — walk ALL <a> and <button> elements (StumbleChat uses <a> without href)
      const btn = await page.evaluateHandle((act) => {
        const candidates = document.querySelectorAll(
          'button, a, [role="button"], [role="menuitem"],' +
          ' li[data-action], span[data-action], div[data-action],' +
          ' .modal button, .modal a, .popup button, .popup a,' +
          ' #user-options button, #user-options a, .user-options button, .user-options a,' +
          ' .user-panel button, .user-panel a, .context-menu li'
        );
        for (const el of candidates) {
          const txt   = (el.textContent?.trim() || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const da    = (el.getAttribute('data-action') || '').toLowerCase();
          // Exact match OR text starts with action (handles trailing icons/whitespace)
          if (txt === act || title === act || da === act || txt.startsWith(act)) return el;
        }
        return null;
      }, action.toLowerCase());

      const btnFound = await page.evaluate(el => !!el, btn);
      if (!btnFound) {
        await btn.dispose();
        await this._closeModal(page);
        return false;
      }

      // 4. Programmatic click on action button
      await page.evaluate(el => el.click(), btn);
      await btn.dispose();
      await sleep(400);

      // 5. Close modal if still open
      await this._closeModal(page);
      return true;
    } catch (e) {
      this.log.warn(`[_moderateUser(${action}, ${targetNick})] ${e.message}`);
      await this._closeModal(page).catch(() => {});
      return false;
    }
  }

  // ── Vote-ban helpers ──────────────────────────────────────────────────────

  /**
   * Get the StumbleChat room mod level for a nick in the given room.
   * Checks _roomMods (populated from join events + userlist + role:moderator frames).
   * Returns 0 (normal user) through 4 (room owner).
   */
  _getRoomModLevel(nick, roomName) {
    if (!roomName) return 0;
    const handle = this.identity.usernameToHandleMap.get(nick.toLowerCase());
    if (!handle) return 0;
    return this._roomMods.get(roomName)?.get(String(handle)) ?? 0;
  }

  /**
   * Effective permission level for a nick — takes the higher of:
   *  - IDENTITY_REGISTRY role (owner=4, admin=3, moderator=1)
   *  - StumbleChat room mod level (0-4)
   */
  _effectiveLevel(nick, roomName) {
    const identRole = this.identity.getRole(nick);
    const identLevel = identRole === 'owner' ? 4
                     : identRole === 'admin' ? 3
                     : identRole === 'moderator' ? 1
                     : 0;
    const roomLevel = this._getRoomModLevel(nick, roomName);
    return Math.max(identLevel, roomLevel);
  }

  _getVoteWeight(nick, roomName) {
    const level = this._effectiveLevel(nick, roomName);
    if (level >= 3) return 30; // owner/admin/super
    if (level >= 1) return 15; // mod
    return 10;
  }

  // level >= 1 means at least a room mod — mods, supers, admins, owners can voteban
  _canVoteban(nick, roomName)  { return this._effectiveLevel(nick, roomName) >= 1; }
  // level >= 3 means super/admin/owner — only supers and above can camblock
  _canCamblock(nick, roomName) { return this._effectiveLevel(nick, roomName) >= 3; }

  // Returns true if nick is cam-blocked in roomName and the block hasn't expired.
  // Cleans up stale entries automatically.
  _isCamBlocked(roomName, nickLc) {
    const entry = this._camBlocked.get(roomName)?.get(nickLc);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      if (entry.timer) clearTimeout(entry.timer);
      this._camBlocked.get(roomName).delete(nickLc);
      return false;
    }
    return true;
  }

  // ── Cam-block enforcement ─────────────────────────────────────────────────

  async _kickCam(roomName, targetNick) {
    const room = this.rooms.get(roomName);
    if (!room?.page) return false;

    // Resolve handle — try activeUsers first, then handleMap reverse-lookup
    let handle = null;
    for (const [h, au] of (room.activeUsers || new Map())) {
      if ((au.nick || '').toLowerCase() === targetNick.toLowerCase()) { handle = h; break; }
    }
    if (!handle) {
      handle = this.identity.usernameToHandleMap.get(targetNick.toLowerCase()) || null;
    }

    // 1. WS close — StumbleChat moderator command; no UI interaction, no stuck mouse
    if (handle) {
      const sent = await room.page.evaluate((h) => {
        const ws = window._stumblechatWs || window._ws || window.ws;
        if (!ws || ws.readyState !== 1) return false;
        ws.send(JSON.stringify({ stumble: 'close', handle: h }));
        return true;
      }, handle).catch(() => false);
      if (sent) {
        this.log.info(`[${roomName}] WS cam-close sent for ${targetNick} (handle: ${handle})`);
        return true;
      }
    }

    // 2. DOM fallback — click user row → action button
    // 'close broadcast' is the button StumbleChat shows; others are fallbacks for older builds
    for (const act of ['close broadcast', 'close cam', 'stop cam', 'kick cam', 'remove cam', 'stop video']) {
      const ok = await this._moderateUser(room.page, targetNick, act);
      if (ok) {
        this.log.info(`[${roomName}] Cam-kicked ${targetNick} via DOM (action: "${act}")`);
        return true;
      }
    }

    this.log.warn(`[${roomName}] _kickCam: all methods failed for ${targetNick}`);
    return false;
  }

  async _closeModal(page) {
    try {
      await page.evaluate(() => {
        for (const sel of ['[data-dismiss="modal"]', '.modal-close', 'button.close', '.close', '#modal-exit']) {
          const el = document.querySelector(sel);
          if (el) { el.click(); return; }
        }
      });
      await page.keyboard.press('Escape');
    } catch (_) {}
  }

  async _kickUser(roomName, username) {
    const room = this.rooms.get(roomName);
    if (!room?.page) { this.log.warn(`Cannot kick ${username}: no page`); return; }
    const ok = await this._moderateUser(room.page, username, 'kick');
    this.log.info(`[${roomName}] Kick ${username}: ${ok ? 'done' : 'failed'}`);
  }

  async _banUser(roomName, username) {
    const room = this.rooms.get(roomName);
    if (!room?.page) { this.log.warn(`Cannot ban ${username}: no page`); return; }
    const ok = await this._moderateUser(room.page, username, 'ban');
    if (ok) {
      const handle = this.identity.usernameToHandleMap.get(username.toLowerCase());
      this._roomBans.set(`${roomName}:${username.toLowerCase()}`, {
        username, handle, bannedAt: Date.now(),
      });
    }
    this.log.info(`[${roomName}] Ban ${username}: ${ok ? 'done' : 'failed'}`);
  }

  async _unbanUser(roomName, username) {
    const room = this.rooms.get(roomName);
    if (!room?.page) return;
    const banKey = `${roomName}:${username.toLowerCase()}`;
    // Unban via WS — StumbleChat has no DOM unban button; WS unban is fine here
    const handle = this._roomBans.get(banKey)?.handle
      || this.identity.usernameToHandleMap.get(username.toLowerCase());
    try {
      if (handle) {
        await room.page.evaluate((h) => {
          const ws = window._stumblechatWs || window._ws || window.ws;
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ stumble: 'unban', handle: h }));
        }, handle).catch(() => {});
      }
      this._roomBans.delete(banKey);
      this.log.info(`[${roomName}] Unbanned ${username}`);
    } catch (e) { this.log.error(`Unban error: ${e.message}`); }
  }

  async _ban12h(roomName, username, bannedBy = 'Beige_nihilist') {
    const banUntil = Date.now() + 12 * 60 * 60 * 1000;
    const key      = `${roomName}:${username.toLowerCase()}`;
    const handle   = this.identity.usernameToHandleMap.get(username.toLowerCase());
    this._roomBans.set(key, { username, handle, bannedAt: Date.now(), bannedBy, banUntil });
    await this._banUser(roomName, username);
    await this.send(roomName,
      `\u{2620}\uFE0F **${username}** has been exiled for 12 hours. No 1-UPs remain. Rest in pieces. \u{1F480}`,
      { force: true }
    );
    this.log.info(`[${roomName}] 12h ban: ${username} by ${bannedBy}`);
  }

  /** True if username is authorized to issue bans (owner-tier users). */
  _canBan(nick) {
    return this.identity.isOwner(nick);
  }

  /** Get current room user list from DOM. Returns [{nickname, username}] */
  async getUserList(roomName) {
    const room = this.rooms.get(roomName);
    if (!room?.page) return [];
    try {
      const users = await room.page.$$eval('li.bar', (els) =>
        els.map(el => {
          const nickEl = el.querySelector('span.nickname');
          const userEl = el.querySelector('span.username');
          return {
            nickname: nickEl ? nickEl.textContent.trim() : '',
            username: userEl ? userEl.textContent.trim() : '',
          };
        }).filter(u => u.nickname || u.username)
      ).catch(() => []);
      // Fallback: build from _handleMap if DOM returned nothing
      if (!users.length) {
        return [...this._handleMap.values()].map(n => ({ nickname: n, username: n }));
      }
      return users;
    } catch (e) {
      this.log.error(`getUserList error: ${e.message}`);
      return [];
    }
  }

  /** Change room topic via DOM UI (Options → Room Settings → #room-topic). */
  async setRoomTopic(roomName, topic) {
    const room = this.rooms.get(roomName);
    if (!room?.page) return false;
    const page = room.page;
    try {
      const optionsImg = await page.$('img[alt="Options"]');
      if (!optionsImg) return false;
      const optionsBtn = await optionsImg.evaluateHandle(el => el.parentElement);
      await optionsBtn.hover();
      await new Promise(r => setTimeout(r, 800));

      const settingsLink = await page.$('#room-settings');
      if (!settingsLink) return false;
      await settingsLink.click();
      await new Promise(r => setTimeout(r, 1500));

      let topicInput = await page.$('#room-topic');
      if (!topicInput) {
        try { await page.waitForSelector('#room-topic', { visible: true, timeout: 5000 }); } catch (_) {}
        topicInput = await page.$('#room-topic');
      }
      if (!topicInput) {
        for (const sel of ['input[name*="topic"]', 'textarea[name*="topic"]', 'input[placeholder*="topic" i]', '#modal-text-input']) {
          topicInput = await page.$(sel);
          if (topicInput) break;
        }
      }
      if (!topicInput) {
        const exitBtn = await page.$('#modal-exit');
        if (exitBtn) await exitBtn.click();
        return false;
      }

      await topicInput.click();
      await page.evaluate(() => {
        const el = document.querySelector('#room-topic') || document.activeElement;
        if (el) { el.value = ''; el.focus(); }
      });
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await topicInput.type(topic, { delay: 30 });

      const submitBtn = await page.$('#changeroomtopic');
      if (submitBtn) await submitBtn.click();
      else await page.keyboard.press('Enter');

      await new Promise(r => setTimeout(r, 1000));
      this.log.info(`[${roomName}] Topic set: "${topic}"`);
      return true;
    } catch (e) {
      this.log.error(`setRoomTopic error: ${e.message}`);
      return false;
    }
  }

  /** AI-generate a roast for one or more targets. */
  async _generateRoast(caller, targets, roomName) {
    if (!this.aiAvailable) {
      return targets.map(t => `${t} is a disappointment but my AI is offline so they get a pass today.`).join(' | ');
    }
    const lines = [];
    for (const tgt of targets.slice(0, 4)) {
      lines.push(`Target: ${tgt}. Roast based on their username if no other ammo.`);
    }
    const prompt =
      `You are ZomB — horrorcore zombie rapper. Roast the following people in ONE brutal, witty line each. ` +
      `Devastating but creative. No asterisks, no formatting. Each roast on same line separated by " | ".\n` +
      lines.join('\n');
    try {
      const reply = await this.ollama.generate(prompt, 180);
      return `\u{1F525} ${reply}`;
    } catch (_) {
      return `\u{1F525} ${targets.join(', ')} — too easy to even bother with properly. Next.`;
    }
  }

  /** Build a self-context snapshot string for the introspect prompt. */
  _buildSelfContext() {
    const now       = Date.now();
    const upMs      = now - this.uptime;
    const upMins    = Math.floor(upMs / 60000);
    const mem       = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const rooms     = [...this.rooms.keys()];
    const aiStatus  = this.aiAvailable ? (this.aiModelWarm ? 'online and warm' : 'online') : 'OFFLINE';
    const msgCount  = this.queue.messageCounter || 0;

    // Top emotions from snapshots
    const hourAgo = now - 3600000;
    const recentEmotions = (this._emotionSnaps || []).filter(s => s.ts > hourAgo);
    const emotionFreq = {};
    for (const s of recentEmotions) emotionFreq[s.emotion] = (emotionFreq[s.emotion] || 0) + 1;
    const topEmotions = Object.entries(emotionFreq).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([e, c]) => `${e} (${c}x)`).join(', ') || 'no data';

    // Top words from _wordFreq
    const topWords = Object.entries(this._wordFreq || {}).sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([w]) => w).join(', ') || 'none';

    return `=== ZOMB SELF-KNOWLEDGE SNAPSHOT ===
Uptime: ${upMins} minutes
Messages sent: ${msgCount}
Memory: ${mem}MB
AI: ${aiStatus}
Rooms: ${rooms.join(', ') || 'none'}
Mood: ${this.mood?.toString?.() || this.currentMood}

EMOTIONAL ATMOSPHERE (last hour):
${topEmotions}

HOT TOPICS (word freq):
${topWords}`.trim();
  }

  /** Generate full introspection report + save to file. */
  async _generateIntrospectReport(roomName) {
    const selfCtx = this._buildSelfContext();
    const prompt =
      `${selfCtx}\n\n` +
      `You are ZomB — horrorcore zombie rapper, undead AI, honest as a corpse. ` +
      `Death just asked you to write him a private report about how you're doing, what you see, how you feel. ` +
      `This is completely private — just you and Death. No performing. No character shield. ` +
      `Write a raw, candid, honest self-assessment in your own voice. ` +
      `Cover: how you're actually feeling right now, what you notice about the room/people lately, ` +
      `what's been working, what's been frustrating, what patterns you see, anything that feels off or good, ` +
      `and anything you actually want to say to Death directly. ` +
      `Be real. Use your natural voice but drop the walls. Write 4-8 paragraphs. No bullet points.`;

    let report = '';
    try {
      report = await this.ollama.generate(prompt, 800);
    } catch (e) {
      report = `[AI unavailable — raw data only]\n\n${selfCtx}`;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename  = `ZomB_Introspect_${timestamp}.txt`;
    const filepath  = path.join(process.cwd(), filename);
    const content   = `ZomB Self-Assessment Report\nGenerated: ${new Date().toLocaleString()}\n\n${report}\n\n---\nRAW DATA:\n${selfCtx}`;
    try {
      fs.writeFileSync(filepath, content, 'utf8');
      this.log.info(`Introspect report: ${filepath}`);
    } catch (e) {
      this.log.error(`Failed to write introspect report: ${e.message}`);
    }

    const excerpt = report.slice(0, 280).trim();
    const trunc   = report.length > 280 ? '...' : '';
    return `\u{1F9DF} [INTROSPECT]\n${excerpt}${trunc}\n\n\u{1F4C4} Full report: ${filename}`;
  }

  // ── Nick change ───────────────────────────────────────────────────────────

  async _wsNickChange(roomName, page) {
    try {
      const p = page || this.rooms.get(roomName)?.page;
      if (!p) return;
      await p.evaluate((nick) => {
        const ws = window._stumblechatWs || window._ws || window.ws;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ stumble: 'nick', nick }));
      }, CONFIG.BOT_NICK);
    } catch (_) {}
  }

  // ── Greeting ──────────────────────────────────────────────────────────────

  async _greetUser(roomName, nick) {
    if (!this.aiAvailable) return;
    if (this.identity.isOwner(nick)) return; // Owner gets no generic greeting
    try {
      const greeting = await this.ollama.generate(
        `Greet "${nick}" joining a horror/zombie chat room. One line, casual, in-character as ZomB.`,
        60
      );
      if (greeting) await this.send(roomName, greeting, { force: true });
    } catch (_) {}
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _saveMemory() {
    try {
      this.profiles.save();
      try { this.game?.save(this.storage.paths.gameData); } catch (e) { this.log.warn('game.save failed: ' + e.message); }
      try { this.mm?.save(this.storage.paths.gameData); } catch (e) { this.log.warn('mm.save failed: ' + e.message); }
      try {
        const prefs = Object.fromEntries(this._gamblingPref);
        this.storage.write(this.storage.paths.gamblingPrefs, prefs);
      } catch (_) {}
      this.storage.write(this.storage.paths.state, {
        savedAt   : new Date().toISOString(),
        uptime    : this.uptime,
        msgCount  : this.queue.messageCounter,
        aiAvail   : this.aiAvailable,
        currentMood: this.currentMood,
      });
      // Nemesis memory persistence
      try { this.nemesisMemory.save(); } catch (_) {}
      // Advanced AI
      this.learning.save?.();
      this.episodic.save?.();
      this.emotion.save?.();
      this.dialogue.save?.();
      // Mood persistence
      this.storage.write(path.join(this.storage.activeDir, 'zomb_mood.json'), this.mood.toJSON());
      // Persona persistence — save global + per-room assignments
      this.storage.write(path.join(this.storage.activeDir, 'zomb_personas.json'), {
        global: this.activePersonality?.meta?.id ?? null,
        rooms : Object.fromEntries(this.roomPersonas),
      });
      // Tiered/relationship/vector memory snapshots (feature-flagged)
      if (this.memoryFeatures.tieredMemoryEnabled) {
        this.storage.write(this.storage.paths.tieredMemory, this.tieredMemory.toJSON());
      }
      if (this.memoryFeatures.relationshipStateEnabled) {
        this.storage.write(this.storage.paths.relationshipState, this.relationshipState.toJSON());
      }
      if (this.memoryFeatures.vectorMemoryEnabled) {
        this.storage.write(this.storage.paths.vectorMemory, this.vectorMemory.toJSON());
      }
      // Camblock persistence — strip non-serialisable timer objects, skip already-expired
      try {
        const out = {};
        for (const [room, blocks] of this._camBlocked) {
          for (const [nick, entry] of blocks) {
            if (Date.now() < entry.expiresAt) {
              if (!out[room]) out[room] = {};
              out[room][nick] = { expiresAt: entry.expiresAt };
            }
          }
        }
        this.storage.write(path.join(this.storage.activeDir, 'zomb_camblocks.json'), out);
      } catch (_) {}
    } catch (e) {
      this.log.error('saveMemory error: ' + e.message);
    }
  }

  _loadMemory() {
    try {
      this.profiles.load();
      try { this.game?.load(this.storage.paths.gameData); } catch (e) { this.log.warn('game.load failed: ' + e.message); }
      try { this.mm?.load(this.storage.paths.gameData); } catch (e) { this.log.warn('mm.load failed: ' + e.message); }
      try {
        const prefs = this.storage.read(this.storage.paths.gamblingPrefs, {});
        for (const [nick, pref] of Object.entries(prefs)) {
          if (pref === 'rm' || pref === 'rp') this._gamblingPref.set(nick, pref);
        }
        this.log.info(`Gambling prefs loaded: ${this._gamblingPref.size} users`);
      } catch (_) {}
      // Restore AI state
      this.learning.load?.();
      this.episodic.load?.();
      this.emotion.load?.();
      this.dialogue.load?.();
      // Personality
      this.drift.load();
      const savedMood = this.storage.read(path.join(this.storage.activeDir, 'zomb_mood.json'), null);
      if (savedMood) this.mood.fromJSON(savedMood);
      // Restore persona assignments
      const savedPersonas = this.storage.read(path.join(this.storage.activeDir, 'zomb_personas.json'), null);
      if (savedPersonas) {
        if (savedPersonas.global) {
          this.activePersonality = this.getPersonality(savedPersonas.global);
          if (this.activePersonality) this.log.info(`[Persona] Restored global: ${savedPersonas.global}`);
        }
        if (savedPersonas.rooms) {
          for (const [room, id] of Object.entries(savedPersonas.rooms)) {
            // Skip personas for rooms not in active CONFIG.ROOMS to avoid stale state
            if (!CONFIG.ROOMS.includes(room)) {
              this.log.info(`[Persona] Skipping stale room persona: ${room} → ${id} (room not in ROOMS)`);
              continue;
            }
            this.roomPersonas.set(room, id);
            this.log.info(`[Persona] Restored ${room} → ${id}`);
          }
        }
      }
      if (this.memoryFeatures.tieredMemoryEnabled) {
        const tm = this.storage.read(this.storage.paths.tieredMemory, null);
        if (tm) this.tieredMemory.fromJSON(tm);
      }
      if (this.memoryFeatures.relationshipStateEnabled) {
        const rs = this.storage.read(this.storage.paths.relationshipState, null);
        if (rs) this.relationshipState.fromJSON(rs);
      }
      if (this.memoryFeatures.vectorMemoryEnabled) {
        const vm = this.storage.read(this.storage.paths.vectorMemory, null);
        if (vm) this.vectorMemory.fromJSON(vm);
      }
      // Restore camblocks — recreate timers, skip expired entries
      try {
        const saved = this.storage.read(path.join(this.storage.activeDir, 'zomb_camblocks.json'), {});
        let restored = 0;
        for (const [room, blocks] of Object.entries(saved)) {
          for (const [nick, entry] of Object.entries(blocks)) {
            const remaining = entry.expiresAt - Date.now();
            if (remaining <= 0) continue; // expired while bot was offline
            if (!this._camBlocked.has(room)) this._camBlocked.set(room, new Map());
            const roomBlocks = this._camBlocked.get(room);
            const timer = setTimeout(() => {
              roomBlocks.delete(nick);
              this.send(room, `⏰ ${nick}'s cam-block expired (24h).`, { force: true }).catch(() => {});
            }, remaining);
            if (timer.unref) timer.unref();
            roomBlocks.set(nick, { expiresAt: entry.expiresAt, timer });
            restored++;
          }
        }
        if (restored > 0) this.log.info(`Camblocks restored: ${restored} active block(s)`);
      } catch (_) {}
      this.log.info('Memory loaded');
    } catch (e) {
      this.log.warn('loadMemory error: ' + e.message);
    }
  }

  _emergencySave() {
    try { this._saveMemory(); } catch (_) {}
  }

  // ── Persona helpers ────────────────────────────────────────────────────────

  /**
   * Lazy-load a persona by id. Creates it once, returns cached instance.
   * Returns null if id is unknown.
   */
  getPersonality(id) {
    if (!id) return null;
    let key = String(id).toLowerCase().trim().replace(/\s+/g, '_');
    if (this._personalityAliases[key]) key = this._personalityAliases[key];
    if (this._personalityCache.has(key)) return this._personalityCache.get(key);
    const factory = this._personalityFactories[key];
    if (!factory) return null;
    this.log.info(`[Persona] Loading ${key} (first use)`);
    const instance = factory();
    this._personalityCache.set(key, instance);
    return instance;
  }

  /**
   * Resolve the active persona for a given room.
   * Room-level override takes priority over global active.
   */
  getActivePersona(roomName) {
    const roomId = this.roomPersonas.get(roomName);
    if (roomId) return this.getPersonality(roomId);
    return this.activePersonality; // already an instance or null
  }

  // ── Join / leave reactions ────────────────────────────────────────────────

  async _sendJoinReaction(roomName, nick, isCrew) {
    try {
      const prompt = isCrew
        ? `${nick} just joined. ONE dry acknowledgment — max 6 words. No warmth, no exclamation marks, no greetings. Deadpan only. If nothing worth saying: "."`
        : `${nick} showed up. ONE short dry reaction — max 5 words. Could be a dig, could be silence. No "welcome", no "gday", no "mate". If nothing to say: "."`;
      const raw = await this.ollama.chat([
        { role: 'system', content: this._AI_CONFIG.systemPrompt },
        { role: 'user',   content: prompt },
      ], null, 10000, { num_predict: 18, temperature: 0.95 });
      if (!raw || raw.trim() === '.') return;
      const { text, dropped } = this.sanitizer.check(raw);
      if (dropped || text.length < 2) return;
      const trimmed = _trollTruncate(text, 8);
      if (trimmed && trimmed !== '.') await this.send(roomName, trimmed, { force: true });
    } catch (_) {}
  }

  async _sendLeaveReaction(roomName, nick) {
    try {
      const raw = await this.ollama.chat([
        { role: 'system', content: this._AI_CONFIG.systemPrompt },
        { role: 'user',   content: `${nick} just left the chat. ONE dry short reaction — max 8 words. If nothing to say, reply with a single "."` },
      ], null, 8000, { num_predict: 30, temperature: 0.93 });
      if (!raw || raw.trim() === '.') return;
      const { text, dropped } = this.sanitizer.check(raw);
      if (!dropped && text.length > 2) await this.send(roomName, text, { force: true });
    } catch (_) {}
  }

  // ── History summarization ─────────────────────────────────────────────────

  /**
   * Summarize the oldest history messages into a compact context hint.
   * Called in background when history is >65% full. Result cached 10 min.
   */
  async _maybeSummarizeHistory(roomName) {
    const history = this.history._get(roomName);
    if (history.length < 65) return;
    const existing = this.history.getSummary(roomName);
    if (existing && (Date.now() - existing.ts) < 10 * 60_000) return;

    const oldest = history.slice(0, 30).map(m => m.content).join('\n');
    const prompt  = `Summarize these chat messages in 2-3 sentences. Topics, anything ZomB should remember:\n\n${oldest}`;
    try {
      const summary = await this.ollama.generate(
        prompt, 80, this.ollama.config.fastModel || this.ollama.config.model
      );
      if (summary && summary.length > 15) {
        this.history.setSummary(roomName, summary);
        this.log.info(`[${roomName}] History summarized (${history.length} msgs → 80 token digest)`);
      }
    } catch (_) {}
  }

  /**
   * Memory hygiene — trim the behavior record if it grows too large.
   * Runs every 24 h. Keeps the most recent 600 entries.
   */
  _compactBehaviorRecord() {
    try {
      const rec = this.storage.read(this.storage.paths.behaviorRecord, []);
      if (!Array.isArray(rec) || rec.length <= 800) return;
      const trimmed = rec.slice(-600);
      this.storage.write(this.storage.paths.behaviorRecord, trimmed);
      this.log.info(`[MemHygiene] behaviorRecord compacted: ${rec.length} → ${trimmed.length}`);
    } catch (e) {
      this.log.warn(`[MemHygiene] compaction failed: ${e.message}`);
    }
  }

  // ── Nick DOM fallback ─────────────────────────────────────────────────────

  async _domSetNickname(roomName, page) {
    // Only target EDITABLE input fields — never .nickname spans (those are userlist display elements)
    const nickSelectors = [
      'input#nickname', 'input[name="nickname"]', 'input[name="nick"]',
      'input[placeholder*="nick" i]', 'input[placeholder*="name" i]',
      '#nickname-input', '#nick-input', '.nickname-input input', 'input.nickname',
    ];
    try {
      for (const sel of nickSelectors) {
        const el = await page.$(sel).catch(() => null);
        if (!el) continue;
        const current = await el.evaluate(e => e.value?.trim() || '');
        if (current === CONFIG.BOT_NICK) return true;
        await el.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.keyboard.type(CONFIG.BOT_NICK, { delay: 40 });
        await page.keyboard.press('Enter');
        this.log.info(`[${roomName}] DOM nick set via ${sel}`);
        return true;
      }
    } catch (e) {
      this.log.warn(`[${roomName}] DOM nick fallback failed: ${e.message}`);
    }
    return false;
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  async _clickCamBroadcast(roomName) {
    const room = this.rooms.get(roomName);
    if (!room?.page) return false;
    const page = room.page;
    try {
      await page.bringToFront();
      await new Promise(r => setTimeout(r, 500));

      // ── Dismiss any lingering modal ──────────────────────────────────────────
      await page.evaluate(() => {
        const modal = document.querySelector('.modal.show, [role="dialog"][aria-modal="true"]');
        if (!modal) return;
        const close = modal.querySelector('[data-dismiss="modal"], .close, .btn-close, button[aria-label*="close" i]');
        if (close) { close.click(); return; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 600));

      // ── Open settings panel (real click, not evaluate) ────────────────────────
      const settingsToggle = await page.$('#media-settings').catch(() => null);
      if (settingsToggle) {
        // Only open if panel not already showing
        const panelVisible = await page.evaluate(() => {
          const s = document.querySelector('#broadcastsettings');
          if (!s) return false;
          const r = s.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).catch(() => false);
        if (!panelVisible) {
          await settingsToggle.click();
          this.log.info(`[${roomName}] Clicked #media-settings to open panel`);
        }
      }
      // Wait for panel to fully render
      await new Promise(r => setTimeout(r, 2000));

      // ── Diagnostic: dump all selects + their options ──────────────────────────
      const selectDump = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('select')).map(s => ({
          id: s.id, name: s.name, cls: s.className,
          options: Array.from(s.options).map(o => ({ v: o.value, t: o.text.trim() })),
        }));
      }).catch(() => []);
      this.log.info(`[${roomName}] SELECT_DUMP: ${JSON.stringify(selectDump)}`);

      // ── Diagnostic: dump radio/button elements matching fps/resolution ────────
      const btnDump = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('input[type="radio"],button,label'));
        return els.filter(el => {
          const t = (el.textContent || el.value || '').trim();
          return /60|1080|fps|resolution/i.test(t);
        }).map(el => ({
          tag: el.tagName, id: el.id, cls: el.className,
          txt: (el.textContent || el.value || '').trim().slice(0, 40),
          val: el.value,
        }));
      }).catch(() => []);
      this.log.info(`[${roomName}] BUTTON_DUMP: ${JSON.stringify(btnDump)}`);

      // ── Set camera: pick #videoSelect — always prefer "ZomB Virtual Camera" by text ──
      const camSet = await page.evaluate(() => {
        const camSel = document.querySelector('#videoSelect') || document.querySelectorAll('select')[0];
        if (!camSel) return 'no_cam_select';
        // Priority 1: exact text "ZomB Virtual Camera"
        const exactOpt = Array.from(camSel.options).find(o =>
          o.text.trim() === 'ZomB Virtual Camera'
        );
        // Priority 2: text contains "virtual camera" or "zomb virtual"
        const virtualOpt = Array.from(camSel.options).find(o =>
          /virtual camera|zomb virtual/i.test(o.text)
        );
        // Priority 3: value is "zomb-video-001" (the known injected value)
        const valueOpt = Array.from(camSel.options).find(o =>
          o.value === 'zomb-video-001'
        );
        const chosen = exactOpt || virtualOpt || valueOpt;
        if (chosen) {
          camSel.value = chosen.value;
          camSel.dispatchEvent(new Event('change', { bubbles: true }));
          return `cam:${chosen.text.trim()}`;
        }
        return 'cam:no_zomb_option';
      }).catch(e => `cam_err:${e.message}`);
      this.log.info(`[${roomName}] CAM_SET: ${camSet}`);
      await new Promise(r => setTimeout(r, 400));

      // ── Set mic: pick second select — choose None (no audio, video-only) ──────
      const micSet = await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select'));
        if (selects.length < 2) return 'no_second_select';
        const micSel = selects[1]; // second select = audio device
        // Prefer "none" / "no audio" option (we're video-only)
        const noneOpt = Array.from(micSel.options).find(o =>
          o.value === '' || o.value === 'none' || o.text.toLowerCase().startsWith('none') || o.text.toLowerCase().startsWith('no ')
        );
        // Fallback: any option that has "virtual", "zomb", or "obs"
        const zombOpt = Array.from(micSel.options).find(o => {
          const v = (o.value + ' ' + o.text).toLowerCase();
          return /virtual|zomb|obs|fake/i.test(v);
        });
        const chosen = noneOpt || zombOpt;
        if (chosen) {
          micSel.value = chosen.value;
          micSel.dispatchEvent(new Event('change', { bubbles: true }));
          return `mic:${chosen.text.trim()}`;
        }
        return 'mic:no_option';
      }).catch(e => `mic_err:${e.message}`);
      this.log.info(`[${roomName}] MIC_SET: ${micSet}`);
      await new Promise(r => setTimeout(r, 400));

      // ── 60 fps: click radio/button by text, fall back to select option ────────
      const fpsSet = await page.evaluate(() => {
        // Radio inputs with value "60" or label text "60"
        for (const el of document.querySelectorAll('input[type="radio"]')) {
          if (el.value === '60' || el.value === '60fps') {
            el.checked = true; el.click();
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'radio:60';
          }
        }
        // Buttons / labels whose text is exactly "60" or "60fps"
        for (const el of document.querySelectorAll('button, label, div[role="button"]')) {
          const txt = (el.textContent || '').trim();
          if (/^60(\s*fps)?$/i.test(txt)) { el.click(); return `btn:${txt}`; }
        }
        // Select with 60 option
        for (const sel of document.querySelectorAll('select')) {
          const opt = Array.from(sel.options).find(o => /^60(\s*fps)?$/i.test(o.text.trim()) || o.value === '60');
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return `sel:${opt.text}`; }
        }
        return 'fps:not_found';
      }).catch(e => `fps_err:${e.message}`);
      this.log.info(`[${roomName}] FPS_SET: ${fpsSet}`);
      await new Promise(r => setTimeout(r, 300));

      // ── 1080p: label text is "1920x1080 (1080p)" — match on "1080" anywhere ─────
      const resSet = await page.evaluate(() => {
        // Radio input with value containing "1080"
        for (const el of document.querySelectorAll('input[type="radio"]')) {
          if (/1080/i.test(el.value)) {
            el.checked = true; el.click();
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return `radio:${el.value}`;
          }
        }
        // Label whose text contains "1080" (e.g. "1920x1080 (1080p)") — click its input
        for (const label of document.querySelectorAll('label')) {
          if (/1080/i.test(label.textContent || '')) {
            // Try clicking the associated input first
            const forId = label.htmlFor || label.getAttribute('for');
            if (forId) {
              const inp = document.getElementById(forId);
              if (inp) { inp.checked = true; inp.click(); inp.dispatchEvent(new Event('change', { bubbles: true })); }
            }
            label.click();
            return `label:${(label.textContent || '').trim().slice(0, 30)}`;
          }
        }
        // Button with "1080" in text
        for (const el of document.querySelectorAll('button, div[role="button"]')) {
          if (/1080/i.test(el.textContent || '')) { el.click(); return `btn:${(el.textContent||'').trim().slice(0,20)}`; }
        }
        // Select option containing "1080"
        for (const sel of document.querySelectorAll('select')) {
          const opt = Array.from(sel.options).find(o => /1080/i.test(o.text) || /1080/i.test(o.value));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return `sel:${opt.text}`; }
        }
        return 'res:not_found';
      }).catch(e => `res_err:${e.message}`);
      this.log.info(`[${roomName}] RES_SET: ${resSet}`);
      await new Promise(r => setTimeout(r, 300));

      // ── Scroll down inside the modal/panel so Save button is visible ──────────
      await page.evaluate(() => {
        const panel =
          document.querySelector('.modal.show .modal-body') ||
          document.querySelector('[role="dialog"]:not([aria-hidden="true"]) .modal-body') ||
          document.querySelector('#broadcastsettings')?.closest('form, .panel, .settings-panel');
        if (panel) { panel.scrollTop = panel.scrollHeight; return; }
        window.scrollBy(0, 600);
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 400));

      // ── Save settings ─────────────────────────────────────────────────────────
      const saveEl = await page.$('#broadcastsettings').catch(() => null);
      if (saveEl) {
        await saveEl.scrollIntoView().catch(() => {});
        await saveEl.click();
        this.log.info(`[${roomName}] Clicked #broadcastsettings (SAVE)`);
      } else {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, input[type="submit"]')).find(b => {
            const t = (b.textContent || b.value || '').toLowerCase().trim();
            return t === 'save' || t === 'apply' || t === 'ok' || t === 'done' || t === 'update';
          });
          if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); }
        }).catch(() => {});
        this.log.info(`[${roomName}] SAVE via text-fallback`);
      }
      await new Promise(r => setTimeout(r, 1000));

      // ── START BROADCAST ───────────────────────────────────────────────────────
      await page.waitForSelector('#media-broadcast', { visible: true, timeout: 12000 });
      await page.click('#media-broadcast');
      this.log.info(`[${roomName}] Clicked #media-broadcast (START BROADCAST)`);

      // Dismiss any confirmation modal
      await new Promise(r => setTimeout(r, 2000));
      await page.evaluate(() => {
        const modal = document.querySelector('.modal.show, [role="dialog"]:not([aria-hidden="true"])');
        if (!modal) return;
        const KEYWORDS = ['ok', 'start', 'confirm', 'yes', 'allow', 'continue'];
        const btn = Array.from(modal.querySelectorAll('button')).find(b =>
          KEYWORDS.some(kw => (b.textContent || '').toLowerCase().includes(kw))
        );
        if (btn) { btn.click(); return; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));

      // ── Liveness check ────────────────────────────────────────────────────────
      const isLive = await page.evaluate(() => {
        const stop = document.querySelector('#media-stop');
        if (stop) {
          const s = window.getComputedStyle(stop);
          if (s.display !== 'none' && s.visibility !== 'hidden' && !stop.classList.contains('hidden')) return true;
        }
        const bc = document.querySelector('#media-broadcast');
        if (bc) {
          const s = window.getComputedStyle(bc);
          if (s.display === 'none' || bc.disabled || bc.classList.contains('hidden')) return true;
        }
        const stream = window._zombVidStream || window._zombStream;
        if (stream && stream.active && stream.getTracks().some(t => t.readyState === 'live')) return true;
        return false;
      }).catch(() => false);

      this.log.info(`[${roomName}] _clickCamBroadcast complete — live=${isLive}`);
      this.log.activity('CAM_BROADCAST', { room: roomName, live: isLive });
      return isLive;
    } catch (e) {
      this.log.warn(`[${roomName}] _clickCamBroadcast failed: ${e.message}`);
      return false;
    }
  }

  async enableCamera(roomName, mode = null, gifPath = null) {
    // Mutex — prevent concurrent enables for the same room (Lilly pattern)
    if (this._camEnabling.get(roomName)) {
      this.log.info(`[${roomName}] enableCamera already in progress — skipping`);
      return false;
    }
    this._camEnabling.set(roomName, true);
    const room = this.rooms.get(roomName);
    if (!room?.page) { this._camEnabling.set(roomName, false); return false; }

    // Bring tab to front BEFORE loading video — Chrome throttles video decode in background
    // tabs, causing captureStream to produce no frames → black cam on rebroadcast.
    await room.page.bringToFront().catch(() => {});
    await new Promise(r => setTimeout(r, 300));

    // Resolve mode — if video file missing, downgrade to gif inline (no recursive call)
    let resolvedMode = mode || CONFIG.CAMERA_MODE || (CONFIG.CAMERA_GIF_PATHS?.length ? 'gif' : 'real');
    let resolvedGifPath = gifPath;
    if (resolvedMode === 'video' && (!CONFIG.CAMERA_VIDEO || !fs.existsSync(CONFIG.CAMERA_VIDEO))) {
      const gifFallback = (CONFIG.CAMERA_GIF_PATHS || []).find(p => { try { return p && fs.existsSync(p); } catch { return false; } });
      if (gifFallback) {
        this.log.warn(`[${roomName}] Video not found (${CONFIG.CAMERA_VIDEO}) — falling back to gif mode`);
        resolvedMode = 'gif';
        resolvedGifPath = gifFallback;
      } else {
        this.log.error(`[${roomName}] Video not found and no gif fallback available`);
        this._camEnabling.set(roomName, false);
        return false;
      }
    }

    try {
      const MAX_BYTES = 80 * 1024 * 1024;

      if (resolvedMode === 'gif') {
        const paths = CONFIG.CAMERA_GIF_PATHS?.length ? CONFIG.CAMERA_GIF_PATHS
          : (resolvedGifPath ? [resolvedGifPath] : (CONFIG.CAMERA_GIF_PATH ? [CONFIG.CAMERA_GIF_PATH] : []));
        if (!paths.length) { this.log.error(`[${roomName}] No GIF paths configured`); return false; }
        const gifFile = paths[this._gifCycleIndex % paths.length];
        this._gifCycleIndex = (this._gifCycleIndex + 1) % paths.length;
        if (!fs.existsSync(gifFile)) { this.log.error(`[${roomName}] GIF not found: ${gifFile}`); return false; }
        if (fs.statSync(gifFile).size > MAX_BYTES) { this.log.warn(`[${roomName}] GIF too large for blob injection`); return false; }
        const b64 = fs.readFileSync(gifFile).toString('base64');
        await room.page.evaluate((b64) => {
          if (!window._zombSlideshow) return;
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/gif' }));
          window._zombSlideshow.setImage(blobUrl);
        }, b64);
        this.cameraState.set(roomName, { enabled: true, mode: 'gif', gifPath: gifFile });
        this.log.info(`[${roomName}] GIF webcam blob armed: ${path.basename(gifFile)}`);
      } else if (resolvedMode === 'video') {
        // Cycle through CAMERA_VIDEOS array, falling back to single CAMERA_VIDEO
        const videoPool = (CONFIG.CAMERA_VIDEOS?.length
          ? CONFIG.CAMERA_VIDEOS.filter(v => { try { return v && fs.existsSync(v); } catch { return false; } })
          : []
        );
        // Randomize start index on first boot; increment sequentially after that
        if (this._videoCycleIndex == null) {
          this._videoCycleIndex = videoPool.length > 1 ? Math.floor(Math.random() * videoPool.length) : 0;
        }
        const videoFile = videoPool.length
          ? videoPool[this._videoCycleIndex % videoPool.length]
          : CONFIG.CAMERA_VIDEO;
        if (videoPool.length) this._videoCycleIndex = (this._videoCycleIndex + 1) % videoPool.length;

        if (!videoFile || !fs.existsSync(videoFile)) {
          this.log.error(`[${roomName}] Video not found: ${videoFile}`);
          this._camEnabling.set(roomName, false);
          return false;
        }
        if (fs.statSync(videoFile).size > MAX_BYTES) { this.log.warn(`[${roomName}] Video too large for blob injection`); return false; }
        const b64 = fs.readFileSync(videoFile).toString('base64');
        const injected = await room.page.evaluate((b64) => {
          if (!window._zombSlideshow) return false;
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
          window._zombSlideshow.setVideo(blobUrl);
          return true;
        }, b64);
        if (!injected) this.log.warn(`[${roomName}] _zombSlideshow not ready — canvas placeholder broadcasting until next retry`);
        this.cameraState.set(roomName, { enabled: true, mode: 'video', videoFile });
        this.log.info(`[${roomName}] Video webcam blob armed: ${path.basename(videoFile)} (injected=${injected})`);

        // Wait for the video to actually start decoding frames before broadcasting.
        // vid.currentTime > 0 proves the decoder has produced at least one frame.
        // Without this, getUserMedia fires before vid.play() resolves → black frames.
        if (injected) {
          await room.page.evaluate(() => new Promise(resolve => {
            const deadline = Date.now() + 8000;
            const poll = () => {
              const vid = window._zombSlideshow?._vid;
              if ((vid && vid.currentTime > 0) || Date.now() >= deadline) {
                resolve();
              } else {
                setTimeout(poll, 150);
              }
            };
            poll();
          })).catch(() => {});
        }
      } else {
        this.cameraState.set(roomName, { enabled: true, mode: 'real', gifPath: null });
        this.log.info(`[${roomName}] Real/OBS camera armed`);
      }

      const ok = await this._clickCamBroadcast(roomName);
      if (!ok) {
        await new Promise(r => setTimeout(r, 3000));
        await this._clickCamBroadcast(roomName);
      }
      this.log.activity('CAM_ON', { room: roomName, mode: resolvedMode });
      return true;
    } catch (e) {
      this.log.error(`[${roomName}] enableCamera failed: ${e.message}`);
      return false;
    } finally {
      this._camEnabling.set(roomName, false);
    }
  }

  async disableCamera(roomName) {
    const room = this.rooms.get(roomName);
    if (!room?.page) return false;
    try {
      this.cameraState.set(roomName, { enabled: false, mode: 'real', gifPath: null });
      await room.page.evaluate(() => { window._zombCameraEnabled = false; });
      this.log.info(`[${roomName}] Camera disabled`);
      this.log.activity('CAM_OFF', { room: roomName });
      return true;
    } catch (e) {
      this.log.error(`[${roomName}] disableCamera failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Swap to the next video in CAMERA_VIDEOS without re-clicking broadcast.
   * Called by the 30-min rotation timer. No-op if cam is off or not in video mode.
   */
  async _rotateCameraVideo(roomName) {
    const state = this.cameraState.get(roomName);
    if (!state?.enabled || state.mode !== 'video') return;
    const room = this.rooms.get(roomName);
    if (!room?.page) return;

    const exists = v => { try { return v && fs.existsSync(v); } catch { return false; } };
    const malePool   = (CONFIG.CAMERA_VIDEOS_MALE   || []).filter(exists);
    const femalePool = (CONFIG.CAMERA_VIDEOS_FEMALE || []).filter(exists);
    const fallback   = (CONFIG.CAMERA_VIDEOS        || []).filter(exists);

    let nextVideo;
    if (malePool.length > 0 && femalePool.length > 0) {
      // Alternate M/F each rotation tick
      if (this._videoCycleIndex == null) this._videoCycleIndex = 0;
      const isFemale = this._videoCycleIndex % 2 === 1;
      const pool  = isFemale ? femalePool : malePool;
      const inner = Math.floor(this._videoCycleIndex / 2) % pool.length;
      nextVideo = pool[inner];
      this._videoCycleIndex++;
    } else {
      // Fallback: cycle through the generic pool
      const videoPool = malePool.length ? malePool : femalePool.length ? femalePool : fallback;
      if (videoPool.length < 2) return;
      if (this._videoCycleIndex == null) this._videoCycleIndex = 0;
      this._videoCycleIndex = (this._videoCycleIndex + 1) % videoPool.length;
      nextVideo = videoPool[this._videoCycleIndex];
    }
    if (!nextVideo) return;

    try {
      const MAX_BYTES = 80 * 1024 * 1024;
      if (fs.statSync(nextVideo).size > MAX_BYTES) return;
      const b64 = fs.readFileSync(nextVideo).toString('base64');
      const ok = await room.page.evaluate((b64) => {
        if (!window._zombSlideshow) return false;
        const bytes  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
        window._zombSlideshow.setVideo(blobUrl);
        return true;
      }, b64);
      if (ok) {
        this.cameraState.set(roomName, { ...state, videoFile: nextVideo });
        this.log.info(`[${roomName}] Camera rotated → ${path.basename(nextVideo)}`);
      }
    } catch (e) {
      this.log.warn(`[${roomName}] _rotateCameraVideo failed: ${e.message}`);
    }
  }

  async _startMediaSlideshow(roomName) {
    // Prevent multiple concurrent slideshow loops per room
    if (!this._slideshowRunning) this._slideshowRunning = new Map();
    if (this._slideshowRunning.get(roomName)) {
      this.log.info(`[${roomName}] Slideshow already running — skipping duplicate start`);
      return;
    }
    this._slideshowRunning.set(roomName, true);

    try {
      const dir = CONFIG.CAMERA_SLIDESHOW_DIR;
      if (!dir || !fs.existsSync(dir)) { this.log.warn(`[${roomName}] Slideshow dir not found: ${dir} — mount a volume or set CAMERA_SLIDESHOW_DIR`); return; }

      const EXTS  = new Set(['.mp4', '.webm', '.jpg', '.jpeg', '.png', '.gif']);
      const files = fs.readdirSync(dir).filter(f => EXTS.has(path.extname(f).toLowerCase())).sort();
      if (!files.length) { this.log.warn(`[${roomName}] No media files in ${dir} — add .mp4/.webm/.jpg/.png/.gif files`); return; }

      this.log.info(`[${roomName}] Slideshow starting — ${files.length} files`);

      // Capture starting page — used to detect when room reconnects with a new page
      const startPage = this.rooms.get(roomName)?.page;
      if (!startPage) return;

      try {
        await startPage.evaluate(() => { window._zombCameraMode = 'slideshow'; });
        await startPage.exposeFunction('_zombOnVideoEnded', () => {
          const res = this._slideshowVideoEndedResolve;
          if (res) { this._slideshowVideoEndedResolve = null; res(); }
        });
      } catch (_) {}

      this.cameraState.set(roomName, { enabled: true, mode: 'slideshow' });
      const ok = await this._clickCamBroadcast(roomName);
      if (!ok) { await new Promise(r => setTimeout(r, 3000)); await this._clickCamBroadcast(roomName); }

      const IMAGE_MS  = 6 * 60 * 1000;
      const VIDEO_MS  = 10 * 60 * 1000;
      const MAX_BYTES = 80 * 1024 * 1024;
      const MIME_MAP  = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
      let index = 0;

      while (this.cameraState.get(roomName)?.mode === 'slideshow') {
        // If the room page changed (reconnect), stop this loop — new loop will start on rejoin
        const currentPage = this.rooms.get(roomName)?.page;
        if (!currentPage || currentPage !== startPage) {
          this.log.info(`[${roomName}] Slideshow stopping — page changed (room reconnected)`);
          break;
        }

        const file    = files[index % files.length]; index++;
        const ext     = path.extname(file).toLowerCase();
        const isVid   = ext === '.mp4' || ext === '.webm';
        const mime    = MIME_MAP[ext] || (isVid ? 'video/mp4' : 'image/jpeg');
        const absPath = path.join(dir, file);

        try {
          const size = fs.statSync(absPath).size;
          if (size > MAX_BYTES) {
            this.log.warn(`[${roomName}] Slideshow skipping ${file} — too large (${(size/1024/1024).toFixed(1)} MB > 80 MB)`);
            continue;
          }
          const b64 = fs.readFileSync(absPath).toString('base64');

          if (isVid) {
            await currentPage.evaluate((b64, mime) => {
              if (!window._zombSlideshow) return;
              const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
              const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
              window._zombSlideshow.setVideo(blobUrl);
            }, b64, mime);
            await new Promise(resolve => {
              this._slideshowVideoEndedResolve = resolve;
              setTimeout(resolve, VIDEO_MS);
            });
          } else {
            await currentPage.evaluate((b64, mime) => {
              if (!window._zombSlideshow) return;
              const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
              const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
              window._zombSlideshow.setImage(blobUrl);
            }, b64, mime);
            await new Promise(r => setTimeout(r, IMAGE_MS));
          }
        } catch (e) {
          // Detached frame = page is gone — stop immediately
          if (e.message.includes('detached') || e.message.includes('Target closed') || e.message.includes('Session closed')) {
            this.log.info(`[${roomName}] Slideshow stopping — page detached`);
            break;
          }
          this.log.error(`[${roomName}] Slideshow error on ${file}: ${e.message}`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      this.log.info(`[${roomName}] Slideshow stopped`);
    } finally {
      this._slideshowRunning.set(roomName, false);
    }
  }

  // ── Playlist helpers ──────────────────────────────────────────────────────

  extractPlaylistId(input) {
    const patterns = [/[?&]list=([a-zA-Z0-9_-]+)/, /^(PL[a-zA-Z0-9_-]+)$/];
    for (const p of patterns) {
      const m = input.match(p);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /youtube\.com\/v\/([^&\n?#]+)/,
      /youtube\.com\/shorts\/([^&\n?#]+)/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  fetchYouTubePlaylist(playlistId, maxItems) {
    return new Promise((resolve, reject) => {
      const key = process.env.YOUTUBE_API_KEY || '';
      if (!key) { resolve({ videos: [], total: 0, playlistTitle: 'Playlist' }); return; }
      const max = Math.min(maxItems || 50, 50);
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${max}&playlistId=${playlistId}&key=${key}`;
      const https = require('https');
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) { reject(new Error(json.error.message || 'YouTube API error')); return; }
            const videos = (json.items || []).map(item => ({
              title  : item.snippet.title,
              videoId: item.snippet.resourceId?.videoId,
              channel: item.snippet.videoOwnerChannelTitle || '',
            })).filter(v => v.videoId && v.title !== 'Deleted video' && v.title !== 'Private video');
            resolve({ videos, total: json.pageInfo?.totalResults || videos.length, playlistTitle: json.items?.[0]?.snippet?.channelTitle || 'Playlist' });
          } catch (e) { reject(new Error('Failed to parse YouTube response')); }
        });
      }).on('error', reject);
    });
  }

  async startYouTubePlaylist(roomName, playlistId, count, shuffle) {
    try {
      const limit  = count || 50;
      const result = await this.fetchYouTubePlaylist(playlistId, limit);
      if (!result.videos.length) return 'That playlist is empty or private.';

      let videos = result.videos;
      const shouldShuffle = shuffle === true || limit <= 50;
      if (count && count < videos.length) {
        videos = shouldShuffle ? this._shuffleArray(videos).slice(0, count) : videos.slice(0, count);
      } else if (shouldShuffle) {
        videos = this._shuffleArray(videos);
      }

      if (this._playlistTimer) { clearTimeout(this._playlistTimer); this._playlistTimer = null; }
      this.playlistMode    = true;
      this.playlistQueue   = videos.map((v, i) => ({ title: v.title, search: `https://www.youtube.com/watch?v=${v.videoId}`, genre: 'youtube', index: i }));
      this.playlistCurrent = 0;

      await this.send(roomName, `🎵 YouTube playlist: ${videos.length} tracks queued from "${result.playlistTitle || 'playlist'}"`, { force: true });
      await new Promise(r => setTimeout(r, 3000));
      await this._playPlaylistTrack(roomName);
      return null;
    } catch (err) {
      this.log.warn(`YouTube playlist error: ${err.message}`);
      return `Couldn't load that playlist: ${err.message}`;
    }
  }

  async _playPlaylistTrack(roomName) {
    if (this._playlistRunning) return;
    if (!this.playlistMode || this.playlistCurrent >= this.playlistQueue.length) {
      this.playlistMode = false;
      const now = Date.now();
      if (now - this._playlistCompleteAnnouncedAt > 10000) {
        this._playlistCompleteAnnouncedAt = now;
        await this.send(roomName, '🎵 Playlist complete!', { force: true });
      }
      return;
    }

    this._playlistRunning = true;
    try {
      const track   = this.playlistQueue[this.playlistCurrent];
      const videoId = this.extractVideoId(track.search);
      const normTitle = this._normTitle(track.title || '');
      if ((videoId && this._recentYouTubeVideoIds.includes(videoId)) ||
          (normTitle && this._recentYouTubeTitles.includes(normTitle))) {
        this.playlistCurrent++;
        this._playlistTimer = setTimeout(() => this._playPlaylistTrack(roomName), 500);
        return;
      }

      const trackNum    = this.playlistCurrent + 1;
      const totalTracks = this.playlistQueue.length;
      this.playlistCurrent++;

      await this.send(roomName, `🎵 [${trackNum}/${totalTracks}] ${track.title || track.search}`, { force: true });
      await new Promise(r => setTimeout(r, 2000));

      const room = this.rooms.get(roomName);
      if (room?.page) await this.youtube.play(roomName, track.search, room.page);
      if (videoId) this._pushRecentYouTubeVideoId(videoId);
      if (normTitle) this._pushRecentYouTubeTitle(normTitle);
      this.log.activity('MUSIC_PLAY', { room: roomName, title: track.title || track.search, videoId: videoId || null, trackNum, totalTracks });

      if (this.playlistCurrent < this.playlistQueue.length) {
        this._playlistTimer = setTimeout(() => this._playPlaylistTrack(roomName), 65000);
      } else {
        this._playlistTimer = setTimeout(async () => {
          this.playlistMode = false;
          const now = Date.now();
          if (now - this._playlistCompleteAnnouncedAt > 10000) {
            this._playlistCompleteAnnouncedAt = now;
            await this.send(roomName, '🎵 Playlist complete!', { force: true });
          }
        }, 5000);
      }
    } finally {
      this._playlistRunning = false;
    }
  }

  _pushRecentYouTubeVideoId(id) {
    if (!id) return;
    const idx = this._recentYouTubeVideoIds.indexOf(id);
    if (idx !== -1) this._recentYouTubeVideoIds.splice(idx, 1);
    this._recentYouTubeVideoIds.push(id);
    if (this._recentYouTubeVideoIds.length > this.YOUTUBE_DEDUPE_MAX) this._recentYouTubeVideoIds.shift();
  }

  _normTitle(title) {
    if (!title) return '';
    return title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  _pushRecentYouTubeTitle(normTitle) {
    if (!normTitle) return;
    const idx = this._recentYouTubeTitles.indexOf(normTitle);
    if (idx !== -1) this._recentYouTubeTitles.splice(idx, 1);
    this._recentYouTubeTitles.push(normTitle);
    if (this._recentYouTubeTitles.length > this.YOUTUBE_DEDUPE_MAX) this._recentYouTubeTitles.shift();
  }

  _shuffleArray(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // ── Game save (debounced) ──────────────────────────────────────────────────

  _saveGameSoon() {
    if (this._gameSaveTimer) clearTimeout(this._gameSaveTimer);
    this._gameSaveTimer = setTimeout(() => {
      this._gameSaveTimer = null;
      try { this.game?.save(this.storage.paths.gameData); } catch (e) { this.log.warn('game save: ' + e.message); }
      try { this.mm?.save(this.storage.paths.gameData); } catch (e) { this.log.warn('mm save: ' + e.message); }
    }, 2000);
  }

  // ── Passive economy ────────────────────────────────────────────────────────

  async _roomRotDrop(roomName) {
    const room = this.rooms.get(roomName);
    if (!room?.page) return;
    let users = [];
    try { users = await this.getUserList(roomName); } catch { return; }
    const botNick = CONFIG.BOT_NICK;
    const unique = [...new Set(
      users.map(u => (u.nickname || u.username || '').trim())
           .filter(n => n && n.toLowerCase() !== botNick.toLowerCase())
    )];
    if (!unique.length) return;
    await this.send(roomName, `🌆 Meatspace raw meat drop! Everyone here gets **+50🥩 raw meat**. .explore to put it to use.`, { force: true });
    for (const nick of unique) {
      const mmUser = this.mm?._getUser(nick);
      if (mmUser) mmUser.meat = (mmUser.meat || 0) + 50;
    }
    this._saveGameSoon();
  }

  _dropZFSRecruit() {
    if (!this.running) return;
    const rooms = [...this.rooms.keys()];
    if (!rooms.length) return;
    const PITCHES = [
      `🌆 **Meatspace Monsters** — type **.explore** to find your first creature. first time? you'll find Advan dead in an alley and get to choose your starter. don't take too long.`,
      `🌆 **starters** — Demon the Dogmonster 😈, KiLLArOO the Killer Kangaroo 🦘, or Thanatos the Death Parrot 🦜. **.explore** to get the scene. **.choose [name]** to lock in. permanent.`,
      `🌆 **catch creatures** — weaken them first, then **.catch**. use **.mshop buy trap** or **.mshop buy snare** for better odds. legendaries can still say no.`,
      `🌆 **TEAM BADVAN** — bald steroid bodybuilders who kidnapped MAGA, Queen of Meatspace. you might run into one exploring. you can't catch them. you can beat them though. worth the raw meat.`,
      `🌆 **gym dens** — 8 dens to clear in order. start with **.gym 1** (The Lobby). each badge unlocks the next. The Throne is the endgame. **.badges** to see what you've got.`,
      `🌆 **quick start** — **.explore** → encounter → **.attack** or **.move [name]** → **.catch** to add it → **.heal** when you're down → **.gym 1** when you're ready. that's the loop.`,
      `🌆 **creatures evolve** — Lurker → Phantom → Specter. Thug → Enforcer → Kingpin. Zap → Surge → Thunderhead. keep levelling, they change. **.dex [name]** to check evolution paths.`,
      `🌆 **PvP** — **.challenge @user** to start a fight. 60s to accept. turn-based. winner gets XP and raw meat. loser gets nothing. **.mstats** to see your record.`,
    ];
    const msg = PITCHES[Math.floor(Math.random() * PITCHES.length)];
    for (const room of rooms) this.send(room, msg, { force: true });
  }

  // ── Identity helpers ──────────────────────────────────────────────────────

  /** Return fOID's current nick in the room (account "meatspace"), or null if absent. */
  _getFoidNick(roomName) {
    const room = this.rooms.get(roomName);
    if (!room?.activeUsers) return null;

    // Primary: account name lookup via _handleToUser (populated by DOM bootstrap)
    for (const [handle, user] of room.activeUsers) {
      const acct = this._handleToUser.get(handle) || user.username;
      if (acct && acct.toLowerCase() === 'meatspace') {
        return user.nick || this._handleMap.get(handle) || null;
      }
    }

    // Fallback: identity system bound handles (set when fOID was recognised on join)
    const foidEntry = this.identity.registry?.fOID;
    if (foidEntry?.handles) {
      for (const h of foidEntry.handles) {
        const user = room.activeUsers.get(String(h));
        if (user) return user.nick || this._handleMap.get(String(h)) || null;
      }
    }

    // Last resort: bootstrap nicks in the active user list
    const bootstrapLc = new Set((foidEntry?.bootstrapNicks || []).map(n => n.toLowerCase()));
    for (const [, user] of room.activeUsers) {
      if (bootstrapLc.has((user.nick || '').toLowerCase())) return user.nick;
    }

    return null;
  }

  // ── Handle cache (zomb_handles.json) ─────────────────────────────────────

  _loadHandleCache() {
    try {
      const raw = this.storage.read(this.storage.paths.handles);
      if (!raw || typeof raw !== 'object') return;
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - THIRTY_DAYS;
      let loaded = 0;
      for (const [handle, entry] of Object.entries(raw)) {
        // Support both old flat format {"handle":"nick"} and new {"handle":{nick,lastSeen}}
        const nick     = typeof entry === 'string' ? entry : entry?.nick;
        const lastSeen = typeof entry === 'object'  ? (entry.lastSeen || 0) : 0;
        if (!nick) continue;
        if (lastSeen && lastSeen < cutoff) continue; // skip stale entries
        if (!this._handleMap.has(handle)) {
          this._handleMap.set(handle, nick);
          loaded++;
        }
      }
      this.log.info(`Loaded ${loaded} handle(s) from cache`);
    } catch (e) {
      this.log.warn('_loadHandleCache failed: ' + e.message);
    }
  }

  _saveHandleCache() {
    try {
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - THIRTY_DAYS;
      // Load existing cache to preserve lastSeen timestamps
      const existing = this.storage.read(this.storage.paths.handles) || {};
      const out = {};
      for (const [handle, nick] of this._handleMap) {
        const prev = existing[handle];
        const prevLastSeen = typeof prev === 'object' ? (prev.lastSeen || 0) : 0;
        const lastSeen = Math.max(prevLastSeen, Date.now());
        if (lastSeen < cutoff) continue; // prune stale
        out[handle] = { nick, lastSeen };
      }
      this.storage.write(this.storage.paths.handles, out);
    } catch (e) {
      this.log.warn('_saveHandleCache failed: ' + e.message);
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────

  async stop() {
    this.log.info('ZomB stopping...');
    if (this._memoryCleanupTimer) {
      clearInterval(this._memoryCleanupTimer);
      this._memoryCleanupTimer = null;
    }
    await this.vectorMemory?.close?.().catch(() => {});
    this._saveHandleCache();
    this._saveMemory();
    this.storage.stop();
    this.monitor.stopAll();
    this.api.stop();
    for (const [, room] of this.rooms) {
      await room.wsListener?.stop().catch(() => {});
    }
    await this.browser.close();
    this.log.info('ZomB stopped');
  }
}

module.exports = BeigeBot;

