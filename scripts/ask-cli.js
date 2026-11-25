/**
 * ask-cli.js – Interactive terminal question tool for the IEA pipeline.
 *
 * Usage:
 *   node scripts/ask-cli.js "your question here" --dept HR
 *   node scripts/ask-cli.js "how do I reset my password" --dept IT
 */
import '../src/config.js';
import { runPipeline } from '../src/pipeline.js';

// ── Parse CLI arguments ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const deptIdx = args.findIndex((a) => a === '--dept');
const department = deptIdx !== -1 ? args[deptIdx + 1] : 'HR';

// Collect all positional arguments that are not --dept or its value
const question = args
  .filter((a, i) => i !== deptIdx && i !== deptIdx + 1 && !a.startsWith('--'))
  .join(' ');

if (!question.trim()) {
  console.error('Usage: node scripts/ask-cli.js "your question" --dept HR');
  process.exit(1);
}

// ── Run the pipeline ─────────────────────────────────────────────────────────
console.log(`\n│ Question   : ${question}`);
console.log(`│ Department : ${department}\n`);

const result = await runPipeline({ question, department, channel: 'cli' });

// ── Display results ───────────────────────────────────────────────────────────
console.log('─'.repeat(60));
console.log(`ANSWER:\n${result.answer}`);
console.log('─'.repeat(60));
console.log(`Validator  : ${result.verdict}`);
console.log(`Cache hit  : ${result.cacheHit}`);
console.log(`Latency    : ${result.latencyMs}ms`);

if (result.sources.length > 0) {
  console.log('\nSources:');
  result.sources.forEach((s) =>
    console.log(`  - ${s.source} (score: ${s.score?.toFixed(3)})`)
  );
}

process.exit(0);
