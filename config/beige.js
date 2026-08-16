// =============================================================================
// config/beige.js — Beige_nihilist bot configuration
// Loaded by BeigeBot.js. Do not require('dotenv') here — bot does it first.
// =============================================================================
'use strict';

const path = require('path');
const { BROWSER_PATH, OLLAMA, RATE, DEFAULTS } = require('./shared');

// ========================== MAIN CONFIG =====================================

const _dataDir = process.env.BEIGE_DATA_DIR || path.join(__dirname, '..', 'Beige_Data');

const CONFIG = {
  LOGIN_EMAIL: process.env.BEIGE_LOGIN_EMAIL || '',
  LOGIN_PASS:  process.env.BEIGE_LOGIN_PASS  || '',
  BOT_NICK:    process.env.BEIGE_BOT_NICK    || 'beige_nihilist',

  ROOMS: process.env.BEIGE_ROOMS
    ? process.env.BEIGE_ROOMS.split(',').map(s => s.trim()).filter(Boolean)
    : ['meatspace'],

  ROOM_ROLES: {
    meatspace: 'guest',
  },

  ROOM_MUSIC_MODE: {
    meatspace: 'off',
  },

  HEADLESS:        DEFAULTS.HEADLESS,
  BROWSER_PATH,
  DEBUG_PORT:      9226,  // separate from Spackle's 9225
  CDP_DEBUG_PORT:  9226,

  RESPONSE_CHANCE:      0.22,
  QUESTION_CHANCE:      0.65,   // Beige loves a question
  AI_ROOM_COOLDOWN_MS:  45000,  // 45s — more deliberate than Spackle
  OWNER_ALWAYS_RESPOND: DEFAULTS.OWNER_ALWAYS_RESPOND,
  MONITOR_INTERVAL:     DEFAULTS.MONITOR_INTERVAL,
  MUSIC_ENABLED:        false,
  DEFAULT_VOLUME:       0,

  CAMERA_ENABLED:       true,
  CAMERA_MODE:          'video',
  CAMERA_VIDEO: process.env.BEIGE_CAM_VIDEO || null,
  CAMERA_VIDEOS: process.env.BEIGE_CAM_VIDEOS
    ? process.env.BEIGE_CAM_VIDEOS.split(',').map(s => s.trim()).filter(Boolean)
    : [],
  CAMERA_VIDEOS_MALE:   [],
  CAMERA_VIDEOS_FEMALE: [],
  CAMERA_GIF_PATH:  null,
  CAMERA_GIF_PATHS: [],
  CAMERA_SLIDESHOW_DIR: null,

  DATA_DIR: _dataDir,
  LOG_FILE: process.env.BEIGE_LOG_FILE || path.join(__dirname, '..', 'beige_boot.log'),
  BOT_PORT: parseInt(process.env.BEIGE_BOT_PORT || '7002', 10),

  KNOWN_HANDLES: {},

  // Bots to never respond to
  KNOWN_BOTS: new Set(['sirloin_v1', 'sirloin', 'lalabot', 'abracadabralala', 'zombv666', 'zomb', 'sophia', 'jessika']),
  // NOTE: Spackle nicks are NOT in KNOWN_BOTS — they are in IDENTITY_REGISTRY as 'nemesis'
  // so NemesisEngine fires instead of the bot being silenced.
};

if (!CONFIG.LOGIN_EMAIL || !CONFIG.LOGIN_PASS) {
  console.error('[Beige] Missing credentials — set BEIGE_LOGIN_EMAIL and BEIGE_LOGIN_PASS in .env');
  process.exit(1);
}

// ========================== IDENTITY REGISTRY ================================

const SPACKLE_NICKS = [
  'Spackle','Spackle_','_Spackle_','SpackleMF','SpackleInc',
  'SpackleDry','PatchGod','FillMaster','DryWallBro','Spackle999',
  'CrackFiller','SpackleGod','spackle',
];

const IDENTITY_REGISTRY = {
  Death: {
    role: 'owner',
    accountName: 'D347H',
    bootstrapNicks: ['death', '_____DOGDICK', 'killarooo', 'killaaroo', 'killaroo', 'kenneth', 'ra_ist', 'd347h'],
    handles: new Set(),
  },
  // Spackle as nemesis — triggers NemesisEngine, NOT the standard AI silencer
  Spackle: {
    role: 'nemesis',
    accountName: 'spackle_account',
    bootstrapNicks: SPACKLE_NICKS,
    handles: new Set(),
  },
};

// ========================== AI CONFIG ========================================

const AI_CONFIG = {
  enabled:              true,
  host:                 OLLAMA.host,
  model:                OLLAMA.model,
  fastModel:            OLLAMA.fastModel,
  fallbackModel:        OLLAMA.fallbackModel,
  maxTokens:            30,
  temperature:          0.88,    // cooler than Spackle's 0.92 — more methodical
  aiResponseChance:     0.80,
  alwaysAIForOwner:     true,
  alwaysAIForQuestions: true,
  alwaysAIForMentions:  true,
  conversationMemory:   30,
  timeoutMs:            OLLAMA.timeoutMs,
  coldStartTimeoutMs:   OLLAMA.coldStartTimeoutMs,
  keepAlive:            OLLAMA.keepAlive,
};

// ========================== ROOM POLICIES ====================================

const ROOM_POLICIES = {
  meatspace: {
    maxTokens    : 12,
    temperature  : 0.88,
    repeatPenalty: 1.5,
  },
};

// ========================== TROLL CONFIG =====================================

const TROLL_CONFIG = {
  enabled:              true,
  minChaosIntervalMs:   15 * 60_000,  // 15 min — Beige is slower to inject than Spackle
  maxEscalationLevel:   5,
  escalationCooldownMs: 25 * 60_000,
  longGameSessionMinMs: 30 * 60_000,

  // Beige's 8 techniques — methodical, void-focused, Socratic
  techniques: [
    'void',              // absorb chaos without reacting; let it die
    'deconstruct',       // take apart the premise stone by stone
    'socratic',          // expose the logic gap with a question
    'agreed_destruction',// agree, then follow the logic to absurd conclusion
    'long_memory',       // reference something from 20+ min ago
    'pattern_call',      // name the pattern someone is running
    'deflation',         // one sentence removing all energy from a moment
    'disappear',         // say something final, then complete silence
  ],

  highPriorityTechniques: ['void', 'disappear'],
  trollScoreThreshold: 3,

  nickPool: [
    'beige_nihilist', 'Beige_nihilist', 'beige_nil', 'beige__',
    'BeigeNil', 'nihilist_b', 'VoidBeige', 'Beige',
  ],
};

// ========================== MEMORY FEATURES ==================================

const MEMORY_FEATURES = {
  tieredMemoryEnabled      : true,
  vectorMemoryEnabled      : true,
  relationshipStateEnabled : true,
  psychAnalyzerEnabled     : true,
  trollLedgerEnabled       : true,
  dramaArchiveEnabled      : true,

  tieredMemory: {
    shortTermWindow     : 90,
    summaryThreshold    : 12,
    maxProfileSize      : 1200,
    maxRooms            : 20,
    maxSummariesPerRoom : 20,
    maxContentLength    : 1500,
  },

  vectorMemory: {
    backend         : process.env.BEIGE_VECTOR_BACKEND || 'memory',
    maxQueryResults : 15,
    maxRecords      : 8000,
    defaultTtlMs    : null,
    backendTimeoutMs: 10000,
    sqlitePath      : process.env.BEIGE_VECTOR_SQLITE_PATH || null,
    tableName       : process.env.BEIGE_VECTOR_TABLE || 'beige_vector_memory',
    pg: {
      connectionString: process.env.BEIGE_VECTOR_PG_URL || null,
      ssl             : String(process.env.BEIGE_VECTOR_PG_SSL || '').toLowerCase() === 'true',
    },
    chromadb: {
      apiKey    : process.env.BEIGE_CHROMA_API_KEY  || null,
      tenant    : process.env.BEIGE_CHROMA_TENANT   || null,
      database  : process.env.BEIGE_CHROMA_DATABASE || 'Beige1',
      collection: process.env.BEIGE_CHROMA_COLLECTION || 'beige_memory',
      path      : 'https://api.trychroma.com',
    },
    embedModel: process.env.BEIGE_EMBED_MODEL || 'nomic-embed-text',
  },

  relationshipState: {
    maxUsersPerRoom : 200,
    maxTopicsPerUser: 15,
    decayMs         : 12 * 60 * 60_000,
  },
};

// ========================== RATE CONFIG =====================================

const RATE_CONFIG = { ...RATE };

module.exports = {
  CONFIG,
  IDENTITY_REGISTRY,
  AI_CONFIG,
  RATE_CONFIG,
  ROOM_POLICIES,
  TROLL_CONFIG,
  MEMORY_FEATURES,
  SPACKLE_NICKS,
};
