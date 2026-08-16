'use strict';

/**
 * ResponseSanitizer — unified output firewall for all AI-generated text.
 *
 * Consolidates sanitization logic previously scattered across _handleChat,
 * _sanitizeOutgoingText, and FreeVoice into one testable module.
 *
 * API:
 *   sanitize(raw)         → cleaned string (may be empty)
 *   score(text)           → { ok, score, reason } quality assessment
 *   check(raw)            → { text, dropped, reason } full pipeline
 */
class ResponseSanitizer {
  constructor(logger) {
    this.log = logger;
  }

  // ── Junk / hallucination patterns ────────────────────────────────────────
  // These phantom phrases signal a poisoned history loop.
  static JUNK = [
    /\bhmuve\b/i,
    /\boutcha\s+loo\b/i,
    /\bsmirkin[g]?\s+at\s+ya\b/i,
    /\bwudn\s+b\b/i,
    /\byeah\s+me\s+buckaroo\b/i,
    /\bjus\s+rollin\s+wit\s+da\s+flow\b/i,
    /lit\s+af\s+if\s+we\s+jus/i,
    /ain't\s+nobody\s+got\s+time\s+fo\b/i,
    /\boutcha\b/i,
    /\boutchea\b/i,
    /\blil\s+sis\b/i,
    /\blil\s+bro\b/i,
    /\blil\s+bit\b/i,
    /\bout\s*here\s+in\s+(meatspace|da\s|the\s+after)/i,
    /catch\s+ya\s+later\s+gotta\s+go/i,
    /gotta\s+go\s+digest\s+some\s+history/i,
    /keep\s+all\s+body\s+parts\s+attached/i,
    // Fake music play announcements — AI confabulating that it played a song
    /^playing\s*[\/|]\s*/i,
    /now\s+playing\s*[\/|:]\s*/i,
    /playing\s+['"']?\w[\w\s]{1,40}['"']?\s+by\s+\w/i,  // "playing 'X' by Y"
    /here\s+we\s+go\s*\.{0,3}\s*🎶/i,
    /let\s+the\s+music\s+play/i,
    // AI outputting bot commands as chat text instead of executing them
    // NOTE: .play / .playlist are intercepted BEFORE send() in _handleChat — don't block here
    /^\.(?:yt|soundcloud|sc)\s+\S/i,
    /^\.(?:bold|italic|color|ban|kick|mute|op|topic|clear|help|info|skip|vote|queue|request|stats|trivia|roll|flip|8ball|weather|define)\b/i,
    // Off-character enthusiasm / filler phrases
    /\bwhat\s+I\s+say\b/i,
    /\bwhat\s+a\s+treat\b/i,
    /\bgonna\s+wear\s+that\b/i,
    /no\s+more\s+drama\s+just\s+fun/i,
    /ezrly\s+plz/i,
    /got\s*it\s+ha+\s*$/i,
    // Hard AAVE drops — these appear constantly and are clearly off-character
    /\bbruh\b/i,
    /\bfam\b/i,
    /\bezrly\b/i,
    /\bwudn\b/i,
    /\bsumthin\b/i,
    /\bya\s+kn[ao]\b/i,
    /\bwatev[3e]r\b/i,
    // AAVE dialect drift — banned regardless of room
    /\bfo\s+(sho|real|sure)\b/i,
    /\bda\s+(real|way|truth|flow|deal|squad|crew|vibe|game)\b/i,
    /\bsumbody\b/i,
    /\bdis\s+(is|aint|ain't|be|right|wrong|how)\b/i,
    /\bplayin\s+at\b/i,
    /\bain't\s+got\s+time\s+fo\b/i,
    /\bwatcha\s+(say|think|want|got|doin)\b/i,
    // Broader AAVE / dialect drift — contractions and dropped-g patterns
    /\bain't\s+(he|she|they|we|it)\b/i,          // "ain't he", "ain't she"
    /\b\w+in'\s+(ta|tah)\s+\w+/i,                // "tryin' ta do", "gonna ta"
    /\bwhat\s+even\s+matter/i,                    // "what even matter" (missing s)
    /\bsomethin'\b/i,
    /\bnothin'\b/i,
    /\beverythin'\b/i,
    // "Death is [negative]" — always reads as targeting the owner Death in meatspace
    // ZomB has no legitimate reason to frame "death" as a joke/loser/waste etc.
    /\bdeath\s+is\s+(such\s+a\s+)?(a\s+)?(joke|loser|waste|sad|pathetic|dead\s+weight|irrelevant|nothing|nobody)\b/i,
    /\byeah\s+death\s+is\b/i,
    // Reddit filler jargon — off-character
    /\bYMMV\b/,
    /\bIMHO\b/i,
    // Spackle-specific lazy filler — AI defaults to these when it has nothing
    /\bsee(?:n)? you around\b/i,      // "see you around" + "seen you around" — dead weight filler
    /^\s*interesting[.!]?\s*$/i,     // standalone "interesting" — zero troll value
    /^\s*interesting\s+(conclusion|departure|timing|exit|point|take|choice|idea|move|theory|approach|observation)[.!]?\s*$/i, // "interesting [noun]" filler combos
    /\bthat sounds kinda sweet\b/i,  // AI going warm
    /\bwhy thank ya\b/i,             // too friendly
    /\bi was feeling left out\b/i,   // needy/warm, not troll voice
    /\bsure thing\b/i,               // too agreeable ("sure thing pal" etc.)
    // "noted" filler — model spams this; as a standalone reply it has no punch
    /^\s*noted[.!]?\s*$/i,           // standalone "noted." drop it entirely
    // "kinda spack [man/bro/etc]" — AI using gendered self-reference, breaks gender-fluid persona
    /\bkinda\s+spack\b/i,
    // Game/economy announcements — ZomB leftovers that break Spackle's persona
    /raw\s+meat\s+drop/i,
    /everyone\s+here\s+gets\s+\+\d+/i,
    /\.explore\s+to\s+put\s+it\s+to\s+use/i,
    // "...right?" conversational filler tag — model appends to rambling responses constantly
    // Strip pass in _sanitizeOutgoingText catches most; JUNK catches any remaining
    /\.{2,}\s*right\?/i,
    // Nick garbling with "saito" suffix — model decomposing "jetskisaito" and reapplying
    /\w{3,}saito\b/i,
    // Dangling subordinate clause — "..., while [adj/adv]" with nothing completing it
    // e.g. "south Korean trends, while adorable" — incomplete thought, drop it
    /,\s*while\s+\w+\s*$/i,
    /,\s*(although|though|because|since|if|but|yet)\s+\w+\s*$/i,
    // Garbled preposition tail — "lead in some bizarrely", "unique in some oddly"
    // Model adds a dangling "in some [adverb]" that makes no grammatical sense
    /\bin\s+some\s+\w+ly\b/i,
    // Standalone adjective/adverb tail after comma — "..., adorable" / "..., unique"
    // catches unfinished comparative clauses that end on a bare descriptor
    /,\s*(adorable|unique|fascinating|interesting|impressive|incredible|remarkable|bizarre|strange|weird|odd)\s*$/i,
  ];

  // ── Adversarial test vectors (prompt-bleed, roleplay, quote-wrap) ─────────
  // Used by unit tests to verify each class of leak is caught.
  static TEST_VECTORS = {
    prompt_bleed : '[DRIFT] yeah that\'s wild',
    roleplay     : '(leans back) not my problem',
    quote_wrap   : '"nah you\'re cooked"',
    transcript   : 'User: hey\nZomB: what do you want',
    junk         : 'outchea trying to vibe',
    stage_action : '*smirks* sure thing',
    context_bleed: 'fair enough\nNext?\nsystem\nZomB state updated',
    hashtag      : 'love it #undeadlife #foreveralone',
  };

  // ── sanitize() ────────────────────────────────────────────────────────────

  /**
   * Strip all known artifacts. Returns cleaned string (may be empty).
   *
   * @param {string} raw
   * @param {Object} opts  — persona-aware options
   *   preserveAsteriskActions {boolean} — keep leading *action* (theatrical personas)
   */
  sanitize(raw, opts = {}) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();
    if (!s) return '';

    // 0. Code block injection bleed — strip any ``` fenced code blocks entirely.
    // These should never appear in ZomB's chat output; if they do, an injection
    // attempt has bled through the context window.
    s = s.replace(/```[\s\S]*?```/g, '').trim();
    // Also catch unclosed fences (attacker pasted opening ``` with no closing)
    s = s.replace(/```[\s\S]*/g, '').trim();
    // Inline backtick-wrapped strings — strip the backticks but keep the content
    s = s.replace(/`([^`\n]{1,200})`/g, '$1').trim();

    // 1. Transcript bleed: "Nick: ... ZomB: actual reply"
    const zombMatch = s.match(/(?:ZomBv?2?\s*:)\s*(.+)$/si);
    if (zombMatch) {
      s = zombMatch[1].trim();
    } else {
      s = s.replace(/^[A-Za-z0-9_\s]{1,30}:\s+/, '').trim();
    }

    // 2. Leaked internal bracket tags: [DRIFT], [MOOD], [ROOM], etc.
    s = s.replace(/\s*\[[A-Z][A-Z\s_]{0,40}\]/g, '').trim();

    // 3. Context/state bleed tails
    s = s.replace(/\n+Next\?[\s\S]*/i, '').trim();
    s = s.replace(/\s+Next\?\s*$/i, '').trim();   // inline "Next?" at end
    s = s.replace(/\n+system\n[\s\S]*/i, '').trim();
    s = s.replace(/\n*ZomB\s+state(?:\s+updated)?[^\n]*/gi, '').trim();

    // 3b. Leading period+quote artifact — AI outputs `. "text"` or `."text"` as a
    // theatrical opener; strip the period so step 4 can handle the quote normally.
    s = s.replace(/^\.\s*(?=["'"'])/, '').trim();

    // 4. Wrapping quotation marks
    s = s.replace(/^["'"']\s*([\s\S]+?)\s*["'"']$/, '$1').trim();

    // 4b-pre. Unmatched leading quote — AI opens with “ but never closes it.
    // Step 4 only strips matched pairs; this catches the lone-opener case.
    if (s.startsWith('”') && (s.match(/”/g) || []).length === 1) {
      s = s.slice(1).trim();
    } else if (s.startsWith('“') && !s.includes('”')) {
      s = s.slice(1).trim();
    }

    // 4c. "Quoted reply." / meta-instruction tail — AI artifact where the actual reply
    // is wrapped in quotes and followed by a slash-separated stage direction or context note.
    // e.g. "Indeed; such trends..." / One must remain vigilant as these phenomena...
    // Keep only the quoted content, strip everything from the slash onward.
    s = s.replace(/^["'"']\s*([\s\S]+?[.!?…])\s*["'"']\s*\/\s*[\s\S]*$/, '$1').trim();

    // 4b. Strip **bold** markdown → plain text.
    // StumbleChat room filters can remove the content between ** markers, leaving
    // visible "* *" artifacts. Converting **text** → text preserves the content.
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1').trim();

    // 5. Stage/tone parentheticals (run twice to catch chained directives)
    // Exclude parens that contain URLs (https?://) — keep everything else.
    // Limit raised to 500 chars to catch long AI meta-instructions like
    // "(Staying true to form requires avoiding any hint of judgmental tone...)"
    const stripParens = (t) => t
      .replace(/\((?![^)]*https?:\/\/)[^)'"]{2,500}\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    s = stripParens(stripParens(s));

    // 6. Whole-line parenthetical tone directives — broad keyword catch + fallback for
    // any line that is entirely a parenthetical (starts and ends with parens, no URL).
    s = s
      .split('\n')
      .filter(line => {
        // Named tone directives
        if (/^\s*\((?:chill|sarcastic|quick|snappy|aggressive|adapting|blend|minimal[-\s]?effort|barely invested|no emojis|cut\b|impulse|cold|adapting quickly|staying true|in character|maintaining|keeping|avoid|note:|reminder:)\b/i.test(line)) return false;
        // Any line that is purely a parenthetical with no URL
        if (/^\s*\([^)]{10,}\)\s*$/.test(line) && !/https?:\/\//.test(line)) return false;
        return true;
      })
      .join('\n')
      .trim();

    // 7. Asterisk-wrapped action openers: *leans back* actual text
    // Theatrical personas (Chopper, Reaper, Rodney Rude) preserve these intentionally.
    // Uses negative lookahead to avoid matching the inner *text* of **bold** markdown.
    if (!opts.preserveAsteriskActions) {
      s = s.replace(/^(\s*(?<!\*)\*[^*]{1,60}\*(?!\*)\s*)+/, '').trim();
    }

    // 7b. Slash-wrapped inline stage directions: /chaos is my home turf/ or /adapting tone/
    // Match /text/ when bordered by whitespace or string boundaries (avoids URLs).
    // Limit raised to 300 chars — AI frequently generates long slash-wrapped meta-instructions.
    s = s.replace(/(^|\s)\/[^\/\n]{2,300}\/(\s|$)/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // 7c. Mid-string *action* stage directions (not preserved by theatrical personas)
    // Leading asterisk-openers are handled in step 7; this catches mid-text injections.
    // Negative lookbehind/lookahead prevents stripping the inner *text* of **bold** markdown.
    if (!opts.preserveAsteriskActions) {
      s = s.replace(/(?<!\*)\*[^*\n]{1,60}\*(?!\*)/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }

    // 8. Hashtag chains
    s = s.replace(/\s*#\w[\w-]*/g, '').trim();

    // 8b. Leaked StumbleChat session handles — 24–36 char hex strings (sometimes emoji-prefixed)
    // These bleed into output when a user's nick is their raw session handle.
    s = s.replace(/\s*[\u{1F000}-\u{1FFFF}\u2705\u2714\u2764\u{1F4AF}]*\s*[0-9a-f]{24,48}\s*$/iu, '').trim();
    // Also strip mid-string handle appearances (handle surrounded by whitespace)
    s = s.replace(/\s[0-9a-f]{24,48}\s/gi, ' ').trim();

    // 9. "Period." narrator artifact — strip inline too (e.g. "...that's it. Period.")
    s = s.replace(/[,.]?\s*Period\.?\s*$/i, '').trim();
    s = s.replace(/\.\s*Period\.\s*/gi, '. ').trim();  // mid-string: ". Period. " → ". "

    // 10. Trailing orphan period
    s = s.replace(/([!?…\u2019\u201d])\s*\.\s*$/, '$1').trim();
    s = s.replace(/\s+\.\s*$/, '').trim();

    // 11. Truncate mid-sentence cut-offs to last complete sentence
    if (s && !/[.!?…"')\u2019\u201d]$/.test(s)) {
      const lastEnd = s.search(/[.!?…][^.!?…]*$/);
      if (lastEnd > 0) s = s.slice(0, lastEnd + 1).trim();
    }

    // 11b. Strip trailing filler question tags — ", right?" / ", no?" / ", eh?" etc.
    // These are conversational hedges the model appends to sound relatable; they bleed
    // Spackle's authority and are always removable without losing the core message.
    s = s.replace(/,?\s*(right|no|yeah|eh|huh|correct|true|innit)\?\s*$/i, '').trim();
    // Trailing tag-question verb phrases after a comma — ", does it?" / ", is it?"
    // Only strip when comma-preceded (i.e. the tag is parenthetical, not the whole point)
    s = s.replace(/,\s*(does|is|isn't|doesn't|can't|won't|are|aren't|did|didn't|has|have|would|could|should)\s+\w{1,12}\?\s*$/i, '').trim();
    // Restore sentence-ending punctuation if the stripping left it bare
    if (s && !/[.!?…]$/.test(s)) {
      const lastEnd = s.search(/[.!?…][^.!?…]*$/);
      if (lastEnd > 0) s = s.slice(0, lastEnd + 1).trim();
    }

    // 11c. Double-question collapse — "X? Y?" → "X?"
    // Model defaults to two-clause format; only the first question lands.
    if ((s.match(/\?/g) || []).length >= 2) {
      const firstQ = s.indexOf('?');
      s = s.slice(0, firstQ + 1).trim();
    }

    // 12. Enforce lowercase first character — Spackle's voice is always lowercase.
    // A capital opener means the model slipped into "assistant mode" (formal sentence start).
    // Only touches the first char to preserve mid-sentence acronyms (AI, DOD, TV, etc.).
    if (s.length > 0 && /^[A-Z]/.test(s)) {
      s = s[0].toLowerCase() + s.slice(1);
    }

    // 12c. Strip "so " as a sentence opener — it's a nodding-observer connector, kills dry voice.
    // "so what would happen..." → "what would happen..."
    // "so, lilly checked out..." → "lilly checked out..."
    // Also catches garbled "so t then..." artifacts.
    s = s.replace(/^so[,\s]+(?:t\s+)?(?:then\s+)?/i, '').trim();
    if (s.length > 0 && /^[A-Z]/.test(s)) s = s[0].toLowerCase() + s.slice(1);

    return s;
  }

  // ── score() ───────────────────────────────────────────────────────────────

  /**
   * Score an already-sanitized reply. Returns { ok, score, reason }.
   * score 0-100; ok = score >= 60.
   *
   * @param {Object} [opts] — align with check(); preserveAsteriskActions skips roleplay penalties for *…* / (…)
   */
  score(text, opts = {}) {
    if (!text || typeof text !== 'string') return { ok: false, score: 0, reason: 'empty' };

    let sc = 100;
    let reason = null;

    const len = text.trim().length;
    if (len < 5)  return { ok: false, score: 0, reason: 'too_short' };
    if (len < 12) { sc -= 30; reason = 'very_short'; }
    if (len > 500) { sc -= 20; reason = reason || 'too_long'; }

    // Residual prompt-bleed tags
    if (/\[(DRIFT|MOOD|ROOM|VILLAIN|SYSTEM|LEARNED)\]/i.test(text)) {
      sc -= 45; reason = 'prompt_bleed';
    }

    // Residual roleplay markers — theatrical / lyrical personas keep these on purpose
    if (!opts.preserveAsteriskActions) {
      if (/\([^)]{2,60}\)/.test(text) || /^\*[^*]+\*/.test(text)) {
        sc -= 25; reason = reason || 'roleplay_marker';
      }
    }

    // Surviving quote wrap
    if (/^["'"'].+["'"']$/.test(text.trim())) {
      sc -= 15; reason = reason || 'quote_wrap';
    }

    // Repetitive 4-gram density
    const words = text.toLowerCase().split(/\s+/);
    if (words.length >= 8) {
      const grams = new Map();
      for (let i = 0; i <= words.length - 4; i++) {
        const g = words.slice(i, i + 4).join(' ');
        grams.set(g, (grams.get(g) || 0) + 1);
      }
      const maxRepeat = Math.max(...grams.values());
      if (maxRepeat >= 3) { sc -= 30; reason = reason || 'repetitive'; }
      else if (maxRepeat >= 2) { sc -= 10; }
    }

    return { ok: sc >= 60, score: Math.max(0, sc), reason };
  }

  // ── hasDialectDrift() ─────────────────────────────────────────────────────

  /**
   * Returns true if the text shows AAVE / dialect drift that shouldn't enter history.
   * Less strict than JUNK (no full drop), but enough to quarantine from context window.
   */
  static DIALECT_DRIFT = [
    // Overused filler words — quarantine from history if present (breaks reinforcement loop)
    /\binnit\b/i,
    /\bmatey\b/i,
    /\bfo\s+(sho|real|sure|da)\b/i,
    /\bda\s+(real|way|truth|flow|deal|squad|vibe|game|whole)\b/i,
    /\b(dis|dat|dem|dey)\b/i,
    /\boutch(a|ea)\b/i,
    /\blil\s+bit\b/i,
    /\bsumbody\b/i,
    /\bya\s+(kno|feel|dig|heard)\b/i,
    /\bain't\s+got\s+time\s+fo\b/i,
    /\bain't\s+(he|she|they|we|it)\b/i,
    /\bjus\s+(be|vibin|rollin|messin|playin)\b/i,
    /\bwatcha\s+(say|think|want|doin)\b/i,
    /\bwudn\b|\binna\b|\bimma\b.*\bimma\b/i,
    /\bsomethin'\b/i,
    /\bnothin'\b/i,
    /\bwhat\s+even\s+matter\b/i,
    // Dropped-letter contractions with apostrophe + ta (common AI AAVE pattern)
    /\b\w+in'\s+ta\b/i,
  ];

  hasDialectDrift(text, opts = {}) {
    if (!text) return false;
    // Eminem and other lyrical personas intentionally use non-standard phrasing in rhyme.
    // Skip drift detection for them entirely.
    if (opts.skipDialectCheck) return false;
    return ResponseSanitizer.DIALECT_DRIFT.some(p => p.test(text));
  }

  // ── check() ───────────────────────────────────────────────────────────────

  /**
   * Full pipeline: sanitize → junk detect → score.
   *
   * @param {string} raw
   * @param {Object} opts  — persona-aware options (from persona.meta.sanitizerOptions)
   *   skipDialectCheck      {boolean} — skip DIALECT_DRIFT detection (Eminem)
   *   skipJunkPatterns      {string[]} — junk pattern indices to skip for this persona
   *   preserveAsteriskActions {boolean} — keep leading *action* (theatrical personas)
   * @returns {{ text: string, dropped: boolean, reason: string|null }}
   */
  check(raw, opts = {}) {
    const text = this.sanitize(raw, opts);
    if (!text) return { text: '', dropped: true, reason: 'empty_after_sanitize' };

    for (const p of ResponseSanitizer.JUNK) {
      if (p.test(text)) return { text, dropped: true, reason: 'junk_pattern' };
    }

    const { ok, reason } = this.score(text, opts);
    if (!ok) return { text, dropped: true, reason };

    return { text, dropped: false, reason: null };
  }
}

module.exports = ResponseSanitizer;
