// =============================================================================
// config/shared.js — Settings shared across ZomB and Lilly bots
// =============================================================================
'use strict';

/** Chrome executable — both bots use the same system Chrome. */
const BROWSER_PATH = process.env.BROWSER_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Ollama API settings — override via env for remote/alt instances. */
const OLLAMA = {
  host:          process.env.OLLAMA_HOST          || 'http://localhost:11434',
  model:         process.env.OLLAMA_MODEL         || 'dolphin3:8b',
  fastModel:     process.env.OLLAMA_FAST_MODEL    || 'llama3.2:1b',
  fallbackModel: process.env.OLLAMA_FALLBACK_MODEL|| 'llama3.1:8b',
  keepAlive:     '2h',
  timeoutMs:     90000,
  coldStartTimeoutMs: 300000,
};

/** YouTube API — one key shared between bots. */
const YOUTUBE = {
  apiKey:          process.env.YOUTUBE_API_KEY || '',
  maxPlaylistItems: 50,
};

/** Rate limiting applied to outbound chat messages. */
const RATE = {
  maxMessagesPerMinute:       20,
  conversationDedupeWindow:   30000,
  messageContentDedupeWindow: 300000,  // 5 min
};

/** Timing and volume defaults used by both bots. */
const DEFAULTS = {
  MONITOR_INTERVAL:  1000,
  DEFAULT_VOLUME:    80,
  HEADLESS:          false,
  OWNER_ALWAYS_RESPOND: true,
};

module.exports = { BROWSER_PATH, OLLAMA, YOUTUBE, RATE, DEFAULTS };
