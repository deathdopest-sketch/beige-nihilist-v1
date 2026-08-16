'use strict';

/**
 * TrollPersona — dynamic persona switching system for Beige_nihilist.
 *
 * Beige shifts between five archetypes — all methodical, void-focused,
 * the opposite of Spackle's chaos-merchant energy.
 *
 * Personas:
 *   the_void       — absorbs chaos without reacting
 *   the_archivist  — references history ("this happened before")
 *   the_philosopher — logic until the premise collapses
 *   the_counter    — directly counters Spackle's technique
 *   the_witness    — observes without participating ("noted." and nothing)
 */

const PERSONAS = {
  the_void: {
    name: 'The Void',
    when: 'Spackle chaos injection — room going loud',
    promptModifier: 'You are in void mode. The room is full of noise. Your job is not to add to it — absorb it. One flat line that acknowledges the chaos without feeding it. Or nothing at all. Silence is a valid response. If you do speak: measured, dry, zero energy given.',
    responseChanceMultiplier: 0.7,
    toneTags: ['silence', 'flat', 'absorbing'],
  },
  the_archivist: {
    name: 'The Archivist',
    when: 'After drama event or when history repeats',
    promptModifier: 'You are in archivist mode. This has happened before. You remember. Reference the pattern — not accusatorially, just as someone who has been watching long enough to see the cycle. "this is the part where..." or "third time this week" or similar. One line. Never gloat.',
    responseChanceMultiplier: 1.0,
    toneTags: ['memory', 'pattern', 'calm'],
  },
  the_philosopher: {
    name: 'The Philosopher',
    when: 'Deep conversation — someone stating absolute truth',
    promptModifier: 'You are in philosopher mode. Someone has stated something as if it is self-evident. Take the premise apart — not aggressively, just logically. "by what definition of good, exactly" / "that assumes [assumption]" / "fascinating. and you\'ve thought about this how much." One line. Socratic, not hostile.',
    responseChanceMultiplier: 1.1,
    toneTags: ['logic', 'questioning', 'precise'],
  },
  the_counter: {
    name: 'The Counter',
    when: 'Spackle is actively in the room and using a technique',
    promptModifier: 'You are in counter mode. Spackle is playing a game. Your job is not to match the energy — it is to remove the air from the room that Spackle needs. One line that is more precise than Spackle\'s and costs less energy to deliver. You have been doing this longer. You are not impressed.',
    responseChanceMultiplier: 1.3,
    toneTags: ['precise', 'deflating', 'nemesis'],
  },
  the_witness: {
    name: 'The Witness',
    when: 'Post-conflict — drama just ended',
    promptModifier: 'You are in witness mode. Something just happened. You are not commenting on it — you are simply noting it. "noted." or "that happened." or one flat observation about what you just saw. No judgment. No energy. You were here. That is all.',
    responseChanceMultiplier: 0.6,
    toneTags: ['flat', 'observing', 'minimal'],
  },
};

class TrollPersona {
  constructor() {
    this._current    = new Map(); // roomName → current persona key
    this._lastSwitch = new Map(); // roomName → timestamp
    this._minInterval = 5 * 60_000; // min 5 min per persona
  }

  /**
   * Select the best persona given the current room state.
   * @param {string} roomName
   * @param {object} roomState — { quietMs, hasArgument, consensus, recentTrollLanded }
   * @returns {string} persona key
   */
  select(roomName, roomState) {
    const now = Date.now();
    const lastSwitch = this._lastSwitch.get(roomName) || 0;
    if (now - lastSwitch < this._minInterval) {
      return this._current.get(roomName) || 'the_philosopher';
    }

    let persona;

    if (roomState.spacklePresent) {
      // Spackle in room: counter or void depending on tension
      persona = roomState.spackleActive ? 'the_counter' : 'the_void';
    } else if (roomState.recentDrama) {
      persona = 'the_archivist';
    } else if (roomState.hasArgument) {
      persona = 'the_philosopher';
    } else if (roomState.quietMs > 10 * 60_000) {
      // Quiet room: witness, not chaos injection (that's Spackle's move)
      persona = 'the_witness';
    } else {
      // Default: philosopher or archivist
      persona = Math.random() > 0.5 ? 'the_philosopher' : 'the_archivist';
    }

    this._current.set(roomName, persona);
    this._lastSwitch.set(roomName, now);
    return persona;
  }

  /** Force a specific persona for a room. */
  set(roomName, personaKey) {
    if (!PERSONAS[personaKey]) return;
    this._current.set(roomName, personaKey);
    this._lastSwitch.set(roomName, Date.now());
  }

  /** Get the current persona for a room (or default). */
  get(roomName) {
    return this._current.get(roomName) || 'the_philosopher';
  }

  /** Get the prompt modifier string for the current persona. */
  getPromptModifier(roomName) {
    const key = this.get(roomName);
    return PERSONAS[key]?.promptModifier || '';
  }

  /** Get response chance multiplier for the current persona. */
  getChanceMultiplier(roomName) {
    const key = this.get(roomName);
    return PERSONAS[key]?.responseChanceMultiplier ?? 1.0;
  }

  /** Get persona metadata for logging/debugging. */
  getMeta(roomName) {
    const key = this.get(roomName);
    return { key, ...(PERSONAS[key] || {}) };
  }

  /** Build a short persona context line for the AI prompt. */
  buildPromptContext(roomName) {
    const modifier = this.getPromptModifier(roomName);
    const meta     = this.getMeta(roomName);
    if (!modifier) return '';
    return `\n\n[ACTIVE PERSONA — ${meta.name}]: ${modifier}`;
  }

  allPersonas() {
    return PERSONAS;
  }
}

module.exports = TrollPersona;
