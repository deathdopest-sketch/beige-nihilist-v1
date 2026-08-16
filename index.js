'use strict';

/**
 * Beige_nihilist v1 — entry point.
 * Run: node index.js
 */

const BeigeBot = require('./src/BeigeBot');

async function main() {
  const bot = new BeigeBot();
  await bot.start();

  const shutdown = async (sig) => {
    console.log(`\n[Beige] Received ${sig} — shutting down gracefully...`);
    try { await bot.stop(); } catch (e) { console.error('Shutdown error:', e.message); }
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('[Beige_nihilist] Fatal startup error:', err);
  process.exit(1);
});
