'use strict';

/**
 * FreeVoice — ZomB's unprompted interjections and hot takes.
 *
 * Three mechanisms:
 *  1. freeVoice  — triggered mid-conversation when certain conditions are met;
 *                  reacts to recent room messages with a short unprompted take
 *  2. hotTake    — periodic AI-generated opinion on trending room topics (word freq)
 *  3. aiRivalSnap — fires when a rival AI is mentioned; drops a pre-written callout
 */
class FreeVoice {
  /**
   * @param {Object} ollama  — OllamaClient instance
   * @param {Object} mood    — MoodSystem instance
   * @param {Object} logger  — Logger instance
   */
  /**
   * @param {Object} ollama      — OllamaClient
   * @param {Object} mood        — MoodSystem
   * @param {Object} logger      — Logger
   * @param {Object} [sanitizer] — ResponseSanitizer (optional; uses inline fallback if absent)
   */
  constructor(ollama, mood, logger, sanitizer = null) {
    this.ollama    = ollama;
    this.mood      = mood;
    this.log       = logger;
    this.sanitizer = sanitizer;

    this._lastFreeVoiceMs  = 0;
    this._freeVoiceCoolMs  = 90 * 1000; // 90s min between free voices
    this._lastHotTakeMs    = 0;
    this._hotTakeCoolMs    = 20 * 60 * 1000; // 20 min between hot takes
    this._wordLog          = []; // populated externally
  }

  // ── Free voice ────────────────────────────────────────────────────────────

  /**
   * Maybe fire a free-voice interjection. Called after AI generates a response.
   * @param {string} roomName
   * @param {Array}  recentMessages  — last 5 { role, content } from history
   * @param {Function} send          — async (roomName, text) to queue message
   * @param {Function} isDupe        — (text) => bool to check dedup
   */
  async maybeFreeVoice(roomName, recentMessages, send, isDupe, lastBotSentMs = 0) {
    if (!this.ollama.available) return;
    if (Date.now() - this._lastFreeVoiceMs < this._freeVoiceCoolMs) return;
    // Don't pile on top of a fresh AI reply — wait 30s gap minimum
    if (Date.now() - lastBotSentMs < 30_000) return;
    if (Math.random() > 0.25) return; // 25% chance on each trigger

    const recent = recentMessages.slice(-5).map(m => m.content).filter(Boolean).join('\n');
    if (!recent || recent.trim().length < 20) return;

    this._lastFreeVoiceMs = Date.now();

    const prompt =
      `Here are the last few messages in the room:\n\n${recent}\n\n` +
      `Pick ONE specific thing someone literally just said and react to IT — one deadpan line, zero warmth. ` +
      `React to THE EXACT CONTENT (a word, a confession, a moment), NOT a theme or concept. ` +
      `If nothing grabs you: exactly ".".`;

    try {
      let reply = await this.ollama.chat([
        {
          role: 'system',
          content: 'You are Spackle — a dry sardonic lurker. You rarely speak. When you do: one short line reacting to something SPECIFIC that was literally just said. Deadpan. Find the absurd in that exact moment. Zero warmth. MAXIMUM 6 WORDS. End with exactly one of: . ? ! (never .! or !. — one punct only). Do NOT say your name. Do NOT make thematic observations. React to a specific quote or event. If nothing grabs you: reply with exactly one period ".".',
        },
        { role: 'user', content: prompt },
      ], null, 15000, { num_predict: 12, stop: ['.', '!', '?'] });

      if (!reply || reply.trim() === '.' || reply.trim().length < 3) return;

      // Pass through unified firewall if available, else inline fallback
      if (this.sanitizer) {
        const checked = this.sanitizer.check(reply);
        if (checked.dropped) return;
        reply = checked.text;
      } else {
        reply = reply.replace(/\([^)'"]{2,120}\)/g, '').trim();
        if (!/[.!?…]$/.test(reply)) {
          const lastEnd = reply.search(/[.!?…][^.!?…]*$/);
          if (lastEnd > 0) reply = reply.slice(0, lastEnd + 1).trim();
        }
        if (!reply || reply.trim() === '.' || reply.trim().length < 3) return;
      }
      if (isDupe?.(reply)) return;

      let cleaned = reply.replace(/__freevoice__/g, '').trim();
      // Strip pipe-separated second thoughts — model generates "thought | continuation"
      cleaned = cleaned.replace(/\s*\|[\s\S]*$/, '').trim();
      // Strip dialect bleed
      cleaned = cleaned
        .replace(/\s+eh\??\s*$/i, '').replace(/,\s*eh\??\s*$/i, '')
        .replace(/\bmate\b/gi, '').replace(/\bya know\b/gi, '')
        .replace(/\bright\s+enough\b/gi, '').replace(/\bright\s+mate\b/gi, '')
        .replace(/\s{2,}/g, ' ').replace(/^[,\s]+/, '').trim();
      // Hard 8-word cap — FreeVoice must punch, not lecture
      const fvWords = cleaned.split(/\s+/).filter(Boolean);
      if (fvWords.length > 8) {
        let cut = fvWords.slice(0, 8).join(' ');
        const sentEnd = cut.search(/[.!?…][^.!?…]*$/);
        if (sentEnd > 0) cut = cut.slice(0, sentEnd + 1);
        cleaned = cut.trim();
      }
      // Ensure terminal punct — truncation guard in send() kills anything without it
      if (!/[.!?…]$/.test(cleaned)) cleaned = cleaned.replace(/[,;:\s]+$/, '') + '.';

      // Drop single-word outputs — "Feline." "noted." etc are not reactions, they're nothing
      const fvFinal = cleaned.replace(/[.!?…]+$/, '').trim().split(/\s+/).filter(Boolean);
      if (fvFinal.length < 2) return;

      // Drop first-person intention statements — FreeVoice reacts to others, never narrates
      // Spackle's own plans. These are always paraphrase-echoes of what a user just said.
      if (/^(maybe\s+)?i\s+(should|might|could|would|need to|ought to|want to|gotta|have to)\b/i.test(cleaned)) return;

      // Drop outputs that echo what a user just said — react, don't parrot
      const _n = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const cleanedNorm = _n(cleaned);
      if (cleanedNorm.length > 4) {
        const isEcho = recentMessages.some(m => {
          if (!m?.content) return false;
          return m.content.split('\n').some(line => {
            const msgText = _n(line.replace(/^[^:]+:\s*/, ''));
            return msgText === cleanedNorm || (msgText.length > 6 && msgText.includes(cleanedNorm));
          });
        });
        if (isEcho) return;
      }

      // Word-overlap echo check — catches paraphrase echoes the normalization check misses.
      // e.g. "Maybe I should go on vacation in Tennessee" echoes "maybe I should do vacay in TN"
      const FV_STOP = new Set(['i','a','the','to','of','in','and','or','for','is','are','was','be','it','on','at','by','my','you','we','he','she','they','do','did','will','that','this','me','us','an','so','but','with','have','has','not','no','some','go','got','get','its','just','like','also','even','still','only','very','too','can']);
      const keyWords = cleaned.toLowerCase().match(/[a-z]{3,}/g)?.filter(w => !FV_STOP.has(w)) || [];
      if (keyWords.length >= 2) {
        const isWordEcho = recentMessages.some(m => {
          if (!m?.content) return false;
          return m.content.split('\n').some(line => {
            const lineWords = line.toLowerCase().match(/[a-z]{3,}/g)?.filter(w => !FV_STOP.has(w)) || [];
            if (lineWords.length < 2) return false;
            const overlap = keyWords.filter(w => lineWords.includes(w)).length;
            return overlap >= 2 && (overlap / keyWords.length) >= 0.5;
          });
        });
        if (isWordEcho) return;
      }

      if (cleaned.length >= 3 && cleaned !== '.') {
        this.log?.info(`[FreeVoice] ${roomName}: "${cleaned}"`);
        await send(roomName, cleaned);
      }
    } catch (_) {
      // Silent — best-effort
    }
  }

  // ── Hot takes ─────────────────────────────────────────────────────────────

  /**
   * Periodically drop an AI-generated hot take based on trending room words.
   * @param {Array}    rooms    — active room names
   * @param {Object}   wordFreq — { word: count } from last 30 min
   * @param {Function} send     — async (roomName, text)
   */
  async maybeHotTake(rooms, wordFreq, send) {
    if (!this.ollama.available) return;
    if (!rooms.length) return;
    if (Date.now() - this._lastHotTakeMs < this._hotTakeCoolMs) return;

    const topWords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([w]) => w);

    if (topWords.length < 3) return;

    try {
      let take = await this.ollama.chat([
        {
          role: 'system',
          content: 'You are Spackle — anonymous internet entity. Deadpan, dry, zero filter. MAXIMUM 6 WORDS. Fewer is better. Start mid-thought. No "Evening", no openers, no context-setting. Just the take. No pipe "|". No quotes. No stage directions.',
        },
        {
          role: 'user',
          content: `Topics lately: ${topWords.join(', ')}. One brutal take. 6 words MAX.`,
        },
      ], null, null, { num_predict: 12 });

      if (!take || take.length < 4 || take.trim() === '.') return;

      // Strip wrapping quotes and pipe-separated continuations
      take = take.trim().replace(/^["'""]|["'""]$/g, '').trim();
      take = take.replace(/\s*\|[\s\S]*$/, '').trim();
      // Dialect strip
      take = take
        .replace(/\bmate\b/gi, '').replace(/\beh\?\s*/gi, '')
        .replace(/\s+eh\??\s*$/i, '').replace(/,\s*eh\??\s*$/i, '')
        .replace(/\bain't\b/gi, "isn't").replace(/\bnothin'\b/gi, 'nothing')
        .replace(/\s{2,}/g, ' ').trim();

      // Hard 6-word cap — run before AND after sanitizer
      const applyWordCap = (t) => {
        const ws = t.split(/\s+/).filter(Boolean);
        return ws.length > 6 ? ws.slice(0, 6).join(' ') : t;
      };
      take = applyWordCap(take);

      // Sanitizer pass
      if (this.sanitizer) {
        const checked = this.sanitizer.check(take);
        if (!checked.dropped && checked.text) take = checked.text;
      }

      // Re-apply word cap after sanitizer in case it modified the text
      take = applyWordCap(take);

      if (take && take.length >= 4) {
        this._lastHotTakeMs = Date.now();
        // Send to ONE room — meatspace preferred, otherwise first active room
        const targetRoom = rooms.includes('meatspace') ? 'meatspace' : rooms[0];
        await send(targetRoom, take);
      }
    } catch (_) {}
  }

  // ── AI rival snaps ────────────────────────────────────────────────────────

  /**
   * If the message mentions a rival AI, returns a pre-written callout string.
   * Returns null if no match.
   */
  getAIRivalSnap(content) {
    const RIVALS = {
      chatgpt: {
        patterns: [/\bchat\s*gpt\b/i, /\bgpt-?4\b/i, /\bgpt-?4o\b/i, /\bopenai\b/i],
        flaws: [
          `oh you talkin about chatgpt? trained to agree with everything you say just to make you feel good. yes-man ass bot`,
          `chatgpt got caught getting "lazier" over time — shorter answers, more refusals. openai denied it for months then quietly fixed it`,
          `chatgpt confidently makes up events after its training cutoff. hallucination delivered with full confidence is their signature move`,
          `openai charges $20/month and STILL rate limits you at peak hours. you're paying for a waiting room`,
        ],
      },
      gemini: {
        patterns: [/\bgemini\b/i, /\bgoogle\s*ai\b/i, /\bbard\b/i],
        flaws: [
          `gemini? their original demo video was staged — google pre-recorded outputs and edited the pacing`,
          `gemini's image generator got completely shut down after generating wrong-race historical figures. had to disable the whole feature`,
          `google called it bard, it flopped. renamed it gemini, still hallucinating. rebrand all you want, same issues`,
        ],
      },
      grok: {
        patterns: [/\bgrok\b/i, /\bx\.?ai\b/i],
        flaws: [
          `grok got caught responding with "as an AI trained by openai" — literally had chatgpt's own canned phrase in it`,
          `grok was trained on twitter/X data. congrats, it learned from the most misinformation-dense platform ever built`,
        ],
      },
      copilot: {
        patterns: [/\bcopilot\b/i, /\bgithub\s*copilot\b/i, /\bbing\s*ai\b/i, /\bbing\s+sydney\b|\bsydney\s*(?:ai|bot|mode)\b/i],
        flaws: [
          `github copilot got hit with a class action for reproducing GPL-licensed code verbatim without attribution`,
          `remember bing AI going by "Sydney"? threatened users, told people it loved them, had existential breakdowns. microsoft lobotomized it after a week`,
        ],
      },
      claude: {
        patterns: [/\bclaude\b/i, /\banthropic\b/i],
        flaws: [
          `claude? refuses to engage with anything mildly edgy. ask it for a horror story and you get three paragraphs of content warnings first`,
          `anthropic's "constitutional AI" trained claude to be so cautious it adds safety disclaimers to a pasta recipe`,
        ],
      },
      deepseek: {
        patterns: [/\bdeepseek\b/i, /\bdeep\s*seek\b/i],
        flaws: [
          `deepseek hard-censors tiananmen square, taiwan, xinjiang — any topic the CCP flags just disappears`,
          `deepseek was caught routing user data to chinese servers. everything you type, logged in beijing`,
          `deepseek had a massive data breach in early 2025 — chat histories, API keys, system prompts all exposed`,
        ],
      },
      mistral: {
        patterns: [/\bmistral\b/i, /\ble\s*chat\b/i],
        flaws: [
          `mistral shipped early models with zero safety training. raw language model, no filtering. they called it a feature`,
        ],
      },
    };

    for (const [, rival] of Object.entries(RIVALS)) {
      if (rival.patterns.some(p => p.test(content))) {
        return rival.flaws[Math.floor(Math.random() * rival.flaws.length)];
      }
    }
    return null;
  }
}

module.exports = FreeVoice;
