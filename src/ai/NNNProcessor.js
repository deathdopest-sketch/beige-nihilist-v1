'use strict';

/**
 * NNNProcessor — ZomB-tuned native JS implementation of the NNN architecture.
 * v2 — per-dimension PNN banks, cluster-seeded NCNN rings, fused output wired
 * into classification, cross-feature interaction terms.
 *
 * Architecture: Text → Feature Extraction (12D) → PNN (CLACK-SWING-CLACK, 40%)
 *               → NCNN (Staggered Circular Rings, 60%) → NNN Fusion (×1.25)
 *               → contextType + moodInfluence + score
 *
 * v1 bugs fixed:
 *   PNN: was averaging all 12 features to one scalar before processing — all banks
 *        received identical input, making per-bank weight arrays useless.
 *        Fixed: each bank i processes features[i] directly.
 *   NCNN: was seeding all 3 rings from the same global average — ring dynamics
 *         carried no per-domain information.
 *         Fixed: Ring1←dims 0-3 (structural), Ring2←dims 4-7 (tone/aggression),
 *                Ring3←dims 8-11 (engagement). Transfers at cluster boundaries.
 *   Interpretation: fused output was only used for a global scalar amp. contextType
 *         and moodInfluence still read raw features, making PNN/NCNN irrelevant to
 *         routing. Fixed: sig(i) blends raw feature with normalised fused[i] so NNN
 *         processing actually influences classification. Cross-feature interaction
 *         terms added for hostile depth, dark banter, genuine sadness, and
 *         intellectual question signals.
 *
 * Feature Dimensions (12D — ZomB-tuned):
 *   0  word count density (0..1 at 50 words)
 *   1  char length density (0..1 at 200 chars)
 *   2  intensity markers (!! / ?? / multiple punctuation)
 *   3  caps ratio
 *   4  banter markers (lol/lmao/💀/😂/haha/xd)
 *   5  depth markers (why/how/explain/thoughts/opinion/believe)
 *   6  aggression markers (fuck/shit/hate/angry/kill/pissed/bastard)
 *   7  melancholy markers (sad/miss/alone/wish/lost/empty/tired/depressed)
 *   8  playful/happy markers (😀/😁/hehe/<3/❤️)
 *   9  lexical complexity (words >8 chars)
 *  10  question indicator (contains ?)
 *  11  personal pronoun density (I/me/my — self-reference)
 */
class NNNProcessor {

  constructor() {
    // ── NNN Core Parameters ──────────────────────────────────────────────────
    this.pnn_base_weight      = 0.9;
    this.pnn_right_weight     = 0.85;
    this.pnn_swing_efficiency = 0.95;
    this.pnn_adaptation_rate  = 0.1;

    this.ncnn_transfer_rate    = 0.85;
    this.ncnn_momentum_buildup = 1.015;
    this.ncnn_max_momentum     = 1.6;
    this.ncnn_energy_loss      = 0.96;

    this.pnn_weight    = 0.4;
    this.ncnn_weight   = 0.6;
    this.synergy_bonus = 1.25;

    // ── ZomB Mood State (default: low baseline, spikes from messages) ────────
    this.mood_aggressive = 0.1;
    this.mood_playful    = 0.05;
    this.mood_melancholy = 0.02;

    // ── Adaptive PNN weight banks (12 banks, one per feature dimension) ──────
    this._pnn_left  = new Array(12);
    this._pnn_right = new Array(12);
    for (let i = 0; i < 12; i++) {
      const adapt = 1.0 + this.pnn_adaptation_rate * i;
      this._pnn_left[i]  = this.pnn_base_weight  * adapt;
      this._pnn_right[i] = this.pnn_right_weight * adapt * 0.95;
    }

    // ── Per-bank fused ceiling — precomputed for normalisation ───────────────
    const maxNcnn = this.ncnn_max_momentum * 3 * 0.1; // 0.48
    this._fusedCap = new Array(12);
    for (let i = 0; i < 12; i++) {
      const maxPnn = this.pnn_swing_efficiency * (this._pnn_left[i] + this._pnn_right[i]) * 0.5;
      this._fusedCap[i] = Math.max(
        (maxPnn * this.pnn_weight + maxNcnn * this.ncnn_weight) * this.synergy_bonus,
        0.001
      );
    }
    this._fusedCapMean = this._fusedCap.reduce((s, v) => s + v, 0) / 12;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Sync mood state from VITA bridge so the JS hot-path stays aligned. */
  setMood(aggressive, playful, melancholy) {
    this.mood_aggressive = Math.max(0, Math.min(1, aggressive));
    this.mood_playful    = Math.max(0, Math.min(1, playful));
    this.mood_melancholy = Math.max(0, Math.min(1, melancholy));
  }

  /**
   * Run full NNN pipeline on a message string.
   * Returns { contextType, moodInfluence, score, fused }.
   */
  score(text) {
    if (!text || typeof text !== 'string') {
      return {
        contextType  : 'normal',
        moodInfluence: { aggressive: 0, playful: 0, melancholy: 0 },
        score        : 0,
      };
    }
    const features = this._extractFeatures(text);
    const pnn_out  = this._processPNN(features);
    const ncnn_out = this._processNCNN(features);
    const fused    = this._fuseNNN(pnn_out, ncnn_out);
    return this._interpret(fused, features);
  }

  /** Drop-in replacement for _detectContextType(). */
  detectContextType(text) {
    return this.score(text).contextType;
  }

  // ── Feature Extraction (ZomB-tuned 12D) ────────────────────────────────────

  _extractFeatures(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const wc    = Math.max(words.length, 1);
    const lc    = Math.max(text.length, 1);

    return [
      /* 0  word count density  */ Math.min(wc / 50, 1),
      /* 1  char length density */ Math.min(lc / 200, 1),
      /* 2  intensity markers   */ Math.min((text.match(/[!?]{2,}|\?{2,}/g) || []).length / 3, 1),
      /* 3  caps ratio          */ Math.min((text.match(/[A-Z]/g) || []).length / lc, 1),
      /* 4  banter markers      */ Math.min(
          (text.match(/\b(lol|lmao|lmfao|haha|hehe|xd)\b|[💀😂🤣]/gi) || []).length / 3,
        1),
      /* 5  depth markers       */ Math.min(
          (text.match(/\b(why|how|what|think|feel|believe|explain|thoughts|opinion|consider)\b/gi) || []).length / 5,
        1),
      /* 6  aggression markers  */ Math.min(
          (text.match(/\b(fuck|shit|hate|angry|kill|mad|pissed|bastard|asshole|damn|cunt)\b/gi) || []).length / 3,
        1),
      /* 7  melancholy markers  */ Math.min(
          (text.match(/\b(sad|miss|alone|wish|lost|empty|tired|depressed|lonely|hopeless|numb|broken)\b/gi) || []).length / 3,
        1),
      /* 8  playful/happy       */ Math.min(
          (text.match(/[😀😁😄😃🥰😍🤩❤️]|:\)|:D|<3/g) || []).length / 3,
        1),
      /* 9  lexical complexity  */ words.filter(w => w.replace(/[^a-z]/gi, '').length > 8).length / wc,
      /* 10 question indicator  */ text.includes('?') ? 1 : 0,
      /* 11 pronoun density     */ Math.min(
          (text.match(/\b(i |i'|me |my |myself|i'm|i've|i'd|i'll)\b/gi) || []).length / wc,
        1),
    ];
  }

  // ── PNN: per-dimension banks ────────────────────────────────────────────────
  // v1 bug: collapsed all features to one scalar (inputAvg), making all 12 banks
  // process identical input and produce near-identical output.
  // Fix: each bank i processes features[i] through its own left/right weights.

  _processPNN(features) {
    const out = new Array(12).fill(0);
    for (let bank = 0; bank < 12; bank++) {
      const swung  = features[bank] * this.pnn_swing_efficiency;
      out[bank] = (swung * this._pnn_left[bank] + swung * this._pnn_right[bank]) * 0.5;
    }
    return out;
  }

  // ── NCNN: cluster-seeded staggered rings ────────────────────────────────────
  // v1 bug: seeded all 3 rings from the global feature average — ring dynamics
  // carried no per-domain information.
  // Fix: 3 rings seeded from feature cluster means:
  //   Ring1 ← dims 0-3 (structural: length, intensity, caps)
  //   Ring2 ← dims 4-7 (tone/aggression: banter, depth, aggression, melancholy)
  //   Ring3 ← dims 8-11 (engagement: playful, complexity, question, pronouns)
  // Ring transfers happen at cluster boundaries (i===3 and i===7).

  _processNCNN(features) {
    const out = new Array(12).fill(0);

    const clusterMean = (start) => {
      let s = 0;
      for (let j = start; j < start + 4; j++) s += features[j];
      return s / 4;
    };

    let ring1 = clusterMean(0);  // structural cluster
    let ring2 = clusterMean(4);  // tone/aggression cluster
    let ring3 = clusterMean(8);  // engagement cluster

    for (let i = 0; i < 12; i++) {
      if (ring1 > 0) {
        out[i] += ring1 * 0.1;
        ring1  *= this.ncnn_energy_loss;
        if (i === 3) ring2 = Math.min(ring2 + ring1 * this.ncnn_transfer_rate * this.ncnn_momentum_buildup, this.ncnn_max_momentum);
        if (i === 7) ring3 = Math.min(ring3 + ring1 * this.ncnn_transfer_rate * this.ncnn_momentum_buildup, this.ncnn_max_momentum);
      }
      if (ring2 > 0) {
        out[i] += ring2 * 0.1;
        ring2  *= this.ncnn_energy_loss;
        if (i === 3) ring3 = Math.min(ring3 + ring2 * this.ncnn_transfer_rate * this.ncnn_momentum_buildup, this.ncnn_max_momentum);
        if (i === 7) ring1 = Math.min(ring1 + ring2 * this.ncnn_transfer_rate * this.ncnn_momentum_buildup, this.ncnn_max_momentum);
      }
      if (ring3 > 0) {
        out[i] += ring3 * 0.1;
        ring3  *= this.ncnn_energy_loss;
        if (i === 3) ring1 = Math.min(ring1 + ring3 * this.ncnn_transfer_rate * this.ncnn_momentum_buildup, this.ncnn_max_momentum);
        if (i === 7) ring2 = Math.min(ring2 + ring3 * this.ncnn_transfer_rate * this.ncnn_momentum_buildup, this.ncnn_max_momentum);
      }
    }
    return out;
  }

  // ── NNN Fusion: PNN(40%) + NCNN(60%) × 1.25 synergy ──────────────────────

  _fuseNNN(pnn, ncnn) {
    return pnn.map((p, i) => (p * this.pnn_weight + ncnn[i] * this.ncnn_weight) * this.synergy_bonus);
  }

  // ── Interpretation ──────────────────────────────────────────────────────────
  // v1 bug: fused output used only for a global `amp` scalar — classification
  // still read raw features directly, making PNN/NCNN irrelevant to routing.
  // Fix: sig(i) blends raw feature (60%) with normalised fused[i] (40%) so NNN
  // processing actually influences contextType and moodInfluence decisions.
  // Cross-feature interaction terms capture patterns raw dimensions can't express.

  _interpret(fused, features) {
    // Normalise fused[i] to [0,1] relative to its theoretical maximum
    const nrm = (i) => Math.min(fused[i] / this._fusedCap[i], 1);

    // Effective signal per dimension: 60% raw + 40% NNN-processed
    const sig = (i) => Math.min(features[i] * 0.6 + nrm(i) * 0.4, 1);

    // Overall score — fused mean normalised to [0,1]
    const fusedMean = fused.reduce((s, v) => s + v, 0) / 12;
    const score     = Math.min(fusedMean / this._fusedCapMean, 1);
    const amp       = 1 + score * 0.5; // max 1.5 — softer than v1's (1 + score)

    // ── Cross-feature interaction terms ────────────────────────────────────────
    // Hostile depth: aggression + depth markers = heated intellectual argument
    const hostileDepth      = features[6] * features[5] * 0.4;
    // Dark banter: banter + aggression = roast / dark humor mode
    const darkBanter        = features[4] * features[6] * 0.3;
    // Genuine sadness: melancholy + self-reference = real emotional content
    const genuineSadness    = features[7] * features[11] * 0.5;
    // Intellectual question: complex vocab + question = serious deep inquiry
    const intellectualQ     = features[9] * features[10] * 0.35;

    // ── Context classification ─────────────────────────────────────────────────
    const banterSignal = (
      sig(4)      * 0.45 +
      sig(2)      * 0.25 +
      (1 - sig(0)) * 0.20 +
      darkBanter  * 0.10
    );

    const deepSignal = (
      sig(5)         * 0.35 +
      sig(9)         * 0.30 +
      sig(10)        * 0.25 +
      intellectualQ  * 0.10
    );

    let contextType;
    if (banterSignal > 0.25 && banterSignal > deepSignal) {
      contextType = 'banter';
    } else if (deepSignal > 0.20) {
      contextType = 'deep';
    } else {
      contextType = 'normal';
    }

    // Short-message fallback — anything < ~4 words is always banter
    if (features[0] < 0.08) contextType = 'banter';

    // ── Mood influence ─────────────────────────────────────────────────────────
    const moodInfluence = {
      aggressive: Math.min(
        (sig(6) * 0.55 + hostileDepth * 0.25 + sig(2) * 0.20) * amp
        + this.mood_aggressive * 0.12,
        1),
      melancholy: Math.min(
        (sig(7) * 0.60 + genuineSadness * 0.30 + sig(11) * 0.10) * amp
        + this.mood_melancholy * 0.12,
        1),
      playful: Math.min(
        (sig(8) * 0.50 + sig(4) * 0.30 + (features[4] * features[10]) * 0.20) * amp
        + this.mood_playful * 0.12,
        1),
    };

    return { contextType, moodInfluence, score, fused };
  }
}

module.exports = NNNProcessor;
