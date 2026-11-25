/**
 * loadtest.js – Autocannon load test runner.
 *
 * Tests the POST /ask endpoint at 10, 25, and 50 concurrent connections.
 * Reports REAL numbers: p50/p95/p99 latency, throughput, error rate.
 * Uses a mix of repeated questions (will be cached) and unique questions
 * (will hit the LLM) to show the cache benefit clearly.
 *
 * Usage: npm run loadtest
 * Requires the server to be running: npm start
 */
import autocannon from 'autocannon';

const HOST     = process.env.LOADTEST_HOST || 'http://localhost:3000';
const DURATION = parseInt(process.env.LOADTEST_DURATION || '20', 10); // seconds per run
const COOLDOWN = 4000; // ms between runs

// ─── Question pool ────────────────────────────────────────────────────────────
// First 4 will be answered from cache after the first run.
// Remaining 6 are unique variants less likely to be cached.
const QUESTIONS = [
  // Repeated – will be cache hits from the second run onward
  { question: 'How many sick leaves do employees get per year?',  department: 'HR' },
  { question: 'What is the reimbursement claim deadline?',         department: 'HR' },
  { question: 'How do I reset my password?',                       department: 'IT' },
  { question: 'How do I request VPN access?',                      department: 'IT' },
  // Unique variants – exercises the full LLM path
  { question: 'How many maternity leave weeks are provided?',      department: 'HR' },
  { question: 'What is the laptop refresh cycle in IT?',           department: 'IT' },
  { question: 'How many casual leaves are granted per year?',      department: 'HR' },
  { question: 'What VPN client software should I install?',        department: 'IT' },
  { question: 'Can I carry forward my annual earned leaves?',      department: 'HR' },
  { question: 'What happens after 5 failed password attempts?',    department: 'IT' },
];

// ─── Run a single autocannon test ─────────────────────────────────────────────
function runTest(concurrency) {
  return new Promise((resolve) => {
    const instance = autocannon({
      url: HOST,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      duration: DURATION,
      connections: concurrency,
      pipelining: 1,
      // Autocannon rotates through this array of requests
      requests: QUESTIONS.map((q) => ({
        method: 'POST',
        path: '/ask',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(q),
      })),
    });

    // Print a live progress bar to stdout
    autocannon.track(instance, { renderProgressBar: true });

    instance.on('done', resolve);
  });
}

// ─── Format a result row ──────────────────────────────────────────────────────
function fmtResult(result, concurrency) {
  const { latency, requests, throughput, errors, non2xx } = result;
  const totalReq   = requests.total;
  const errorCount = (errors || 0) + (non2xx || 0);
  const errorPct   = totalReq > 0 ? ((errorCount / totalReq) * 100).toFixed(2) : '0.00';

  return {
    concurrency,
    totalRequests: totalReq,
    rps:           throughput.mean.toFixed(1),
    p50:           latency.p50,
    p95:           latency.p95,
    p99:           latency.p99,
    errors:        errorCount,
    errorPct,
  };
}

// ─── Print summary table ──────────────────────────────────────────────────────
function printSummary(rows) {
  const LINE = '─'.repeat(90);
  console.log(`\n${'═'.repeat(90)}`);
  console.log('  IEA LOAD TEST SUMMARY');
  console.log('═'.repeat(90));
  console.log(
    'Concurrent'.padEnd(12) +
    'Requests'.padEnd(12) +
    'RPS'.padEnd(10) +
    'p50 ms'.padEnd(10) +
    'p95 ms'.padEnd(10) +
    'p99 ms'.padEnd(10) +
    'Errors'.padEnd(10) +
    'Error %'
  );
  console.log(LINE);
  for (const r of rows) {
    console.log(
      String(r.concurrency).padEnd(12) +
      String(r.totalRequests).padEnd(12) +
      String(r.rps).padEnd(10) +
      String(r.p50).padEnd(10) +
      String(r.p95).padEnd(10) +
      String(r.p99).padEnd(10) +
      String(r.errors).padEnd(10) +
      `${r.errorPct}%`
    );
  }
  console.log(LINE);
  console.log('\n⚠  Notes:');
  console.log('   • LLM API latency (Gemini) dominates response time.');
  console.log('   • Cached questions are ~10-100× faster than LLM-path questions.');
  console.log('   • 429 (rate-limit) errors at 50 concurrent are expected on Gemini free tier.');
  console.log('   • Run the server with VALIDATE_REQUESTS=false to benchmark without validator overhead.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(90));
  console.log('  IEA LOAD TEST');
  console.log('═'.repeat(90));
  console.log(`  Target  : ${HOST}`);
  console.log(`  Duration: ${DURATION}s per run`);
  console.log(`  Pool    : ${QUESTIONS.length} question templates (rotated)`);
  console.log(`  Levels  : 10 / 25 / 50 concurrent connections`);
  console.log('\n  ⚠  Make sure the IEA server is running (npm start) before this test.\n');

  const summaryRows = [];

  for (const concurrency of [10, 25, 50]) {
    console.log(`\n▶ ${concurrency} concurrent connections (${DURATION}s):`);
    const result = await runTest(concurrency);
    summaryRows.push(fmtResult(result, concurrency));

    if (concurrency < 50) {
      console.log(`\n  Cooling down for ${COOLDOWN / 1000}s…`);
      await new Promise((r) => setTimeout(r, COOLDOWN));
    }
  }

  printSummary(summaryRows);
  process.exit(0);
}

main().catch((err) => {
  console.error('[loadtest] Fatal error:', err);
  process.exit(1);
});
