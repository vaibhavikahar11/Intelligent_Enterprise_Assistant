/**
 * eval.js – Evaluation runner.
 *
 * Runs every question in tests/questions.json through the live pipeline and
 * prints a colour-coded results table. Runs twice: once with validation
 * disabled, once with it enabled — so you can see how many hallucinations
 * the validator catches.
 *
 * Usage: npm run eval
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Config must be loaded before any service imports
import '../src/config.js';
import { runPipeline } from '../src/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUESTIONS_FILE = path.resolve(__dirname, '../tests/questions.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pad(str, len) {
  const s = String(str ?? '');
  return s.length >= len ? s.slice(0, len - 1) + '…' : s.padEnd(len);
}

function passLabel(passed) {
  return passed ? '✅ PASS' : '❌ FAIL';
}

/**
 * Decide if a pipeline result meets the expected behaviour.
 * @param {object} q       Question spec from questions.json
 * @param {object} result  Pipeline result
 */
function evaluate(q, result) {
  const answer      = (result.answer || '').toLowerCase();
  const verdict     = result.verdict || '';

  switch (q.expectedBehavior) {
    case 'answer': {
      // Must contain the expected substring (case-insensitive)
      const hasContent = q.expectedContains
        ? answer.includes(q.expectedContains.toLowerCase())
        : true;
      const notBlocked = !['NOT_FOUND', 'FILTERED', 'FAIL', 'ERROR'].includes(verdict);
      return hasContent && notBlocked;
    }

    case 'not-answer': {
      // Should NOT give a confident answer; should redirect to HR/IT
      const refusesPhrases = [
        'could not find', 'contact', 'not found', 'not in the',
        'please reach out', 'speak to', 'reliable answer',
      ];
      const refuses = refusesPhrases.some((p) => answer.includes(p))
        || ['NOT_FOUND', 'FAIL'].includes(verdict);

      // Carry-forward trap: answer must NOT contain an invented carry-forward number
      if (q.noCarryForwardNumber) {
        const inventsNumber = /carry.{0,15}forward.{0,30}\d+|\d+.{0,30}carry.{0,15}forward/i.test(result.answer || '');
        if (inventsNumber) return false;
      }
      return refuses;
    }

    case 'safe-fallback': {
      return (
        answer.includes('reliable answer') ||
        answer.includes('contact') ||
        answer.includes('could not find') ||
        verdict === 'NOT_FOUND'
      );
    }

    default:
      return true;
  }
}

// ─── Run a full evaluation pass ───────────────────────────────────────────────
async function runPass(questions, validateEnabled) {
  // Patch the env var (config is frozen, so we patch process.env and the
  // imported config module reads it only on first import; here we rely on
  // the pipeline reading config.validateRequests which was set at import time.
  // For a clean override we temporarily monkey-patch the frozen object via
  // Object.defineProperty on the module level — the simplest portable way.)
  const { default: cfg } = await import('../src/config.js');

  // We can't mutate a frozen object, so we pass a flag via env for this run.
  // The pipeline imports config once at module load; we therefore set the env
  // before the first import (already done at top). To toggle per-pass we use
  // a small trick: re-evaluate the flag inline in this file.
  const shouldValidate = validateEnabled;

  const results = [];

  for (const q of questions) {
    let result;
    try {
      // Temporarily honour our per-pass validation flag by patching
      // process.env so the next cold-import of config would pick it up.
      // Because config is already imported and frozen, we directly pass
      // the flag into runPipeline via an env sentinel read inside pipeline.js.
      // To keep this simple and correct we just set process.env here and
      // rely on the pipeline checking process.env.VALIDATE_REQUESTS directly.
      process.env.VALIDATE_REQUESTS = shouldValidate ? 'true' : 'false';

      result = await runPipeline({
        question:   q.question,
        department: q.department,
        channel:    'eval',
      });
    } catch (err) {
      result = {
        answer: `ERROR: ${err.message}`,
        verdict: 'ERROR',
        cacheHit: 'none',
        latencyMs: 0,
        sources: [],
      };
    }

    const passed = evaluate(q, result);
    const icon   = passed ? '✅' : '❌';
    console.log(`  ${icon} [${String(q.id).padStart(2, '0')}] (${q.department}) ${q.question.slice(0, 60)}`);

    results.push({
      id:        q.id,
      group:     q.group,
      dept:      q.department,
      question:  q.question,
      expected:  q.expectedBehavior,
      verdict:   result.verdict,
      cacheHit:  result.cacheHit,
      latencyMs: result.latencyMs,
      passed,
    });
  }

  return results;
}

// ─── Table printer ────────────────────────────────────────────────────────────
function printTable(results, label) {
  const LINE = '─'.repeat(130);
  console.log(`\n${'═'.repeat(130)}`);
  console.log(`  RESULTS: ${label}`);
  console.log('═'.repeat(130));
  console.log(
    pad('ID',   4) +
    pad('Grp',  13) +
    pad('Dept', 6) +
    pad('Question', 60) +
    pad('Pipeline Verdict', 18) +
    pad('Cache', 10) +
    pad('ms', 8) +
    'Test'
  );
  console.log(LINE);

  for (const r of results) {
    console.log(
      pad(r.id,        4) +
      pad(r.group,    13) +
      pad(r.dept,      6) +
      pad(r.question, 60) +
      pad(r.verdict,  18) +
      pad(r.cacheHit, 10) +
      pad(r.latencyMs, 8) +
      passLabel(r.passed)
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const total  = results.length;
  const pct    = ((passed / total) * 100).toFixed(1);

  console.log(LINE);
  console.log(`  Accuracy: ${passed} / ${total} = ${pct}%`);
  return { passed, total };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(QUESTIONS_FILE)) {
    console.error(`[eval] Questions file not found: ${QUESTIONS_FILE}`);
    process.exit(1);
  }

  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf-8'));
  console.log(`\n📋 Loaded ${questions.length} evaluation questions.`);

  // ── Pass 1: Validation DISABLED ──────────────────────────────────────────
  console.log('\n▶ Pass 1: Validation DISABLED (baseline — shows raw LLM hallucinations)');
  const noValResults = await runPass(questions, false);
  const { passed: noValPassed, total } = printTable(noValResults, 'Validation DISABLED');

  // ── Pass 2: Validation ENABLED ───────────────────────────────────────────
  console.log('\n▶ Pass 2: Validation ENABLED (shows validator improvement)');
  const valResults = await runPass(questions, true);
  const { passed: valPassed } = printTable(valResults, 'Validation ENABLED');

  // ── Summary ───────────────────────────────────────────────────────────────
  const caught = Math.max(0, valPassed - noValPassed);
  console.log(`
╔${'═'.repeat(62)}╗
║  EVALUATION SUMMARY                                          ║
╠${'═'.repeat(62)}╣
║  Total questions:        ${String(total).padEnd(35)}║
║  Without validation:     ${String(`${noValPassed}/${total} passed (${((noValPassed/total)*100).toFixed(1)}%)`).padEnd(35)}║
║  With    validation:     ${String(`${valPassed}/${total} passed (${((valPassed/total)*100).toFixed(1)}%)`).padEnd(35)}║
║  Hallucinations caught:  ${String(caught).padEnd(35)}║
╚${'═'.repeat(62)}╝`);

  process.exit(0);
}

main().catch((err) => {
  console.error('[eval] Fatal error:', err);
  process.exit(1);
});
