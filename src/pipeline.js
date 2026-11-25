/**
 * pipeline.js – Main RAG pipeline orchestrator.
 * Order: filter → cache → embed → retrieve → generate → validate (retry once) → cache write → log
 *
 * Accepts an optional `onStage` callback:
 *   onStage({ stage, status, durationMs, detail })
 * Emitted at every pipeline stage so callers (WebSocket, REST) can stream progress.
 */
import { checkInput }                    from './services/filter.js';
import { cacheGet, cacheSet }            from './services/cache.js';
import { retrieve }                      from './services/retriever.js';
import { generateAnswer, buildSourcesPayload } from './services/generator.js';
import { validate }                      from './services/validator.js';
import { logRequest }                    from './services/logger.js';
import { embedOne }                      from './services/llm.js';
import { queryChunks }                   from './services/vectorStore.js';
import config                            from './config.js';

const SAFE_FALLBACK =
  "I couldn't find a reliable answer in the company documents. Please contact HR/IT directly for assistance.";

const NOT_FOUND_MSG = (dept) =>
  `I couldn't find information about this in the ${dept.toUpperCase()} knowledge base. Please contact ${
    dept.toUpperCase() === 'HR' ? 'HR at hr@company.com' : 'IT Support at it-support@company.com'
  } directly.`;

/**
 * Run the full IEA pipeline.
 * @param {object} params
 * @param {string}   params.question
 * @param {string}   params.department   'HR' | 'IT'
 * @param {string}   [params.channel]    'whatsapp' | 'web' | 'api'
 * @param {string}   [params.phone]
 * @param {Function} [params.onStage]    stage event callback
 * @param {Function} [params.onToken]    streaming token callback (string chunk)
 * @returns {Promise<{answer, sources, validated, cacheHit, latencyMs, verdict, claims}>}
 */
export async function runPipeline({
  question,
  department,
  channel  = 'api',
  phone    = null,
  onStage  = null,
  onToken  = null,
}) {
  const start    = Date.now();
  const dept     = (department || 'HR').toUpperCase();
  const logEntry = { question, department: dept, channel, phone };

  /** Emit a stage event if the caller provided a callback */
  function emit(stage, status, detail = {}) {
    if (typeof onStage === 'function') {
      try { onStage({ stage, status, durationMs: Date.now() - start, ...detail }); }
      catch (_) {}
    }
  }

  try {
    // ── STEP 1: Pre-filter ────────────────────────────────────────────────────
    emit('filter', 'running');
    const filterResult = checkInput(question);
    emit('filter', filterResult.blocked ? 'blocked' : 'pass', { detail: filterResult.reason || null });

    if (filterResult.blocked) {
      const latencyMs = Date.now() - start;
      logRequest({ ...logEntry, answer: filterResult.reason, cacheHit: 'none', latencyMs, error: 'FILTERED' });
      return { answer: filterResult.reason, sources: [], validated: false, cacheHit: 'none', latencyMs, verdict: 'FILTERED', claims: [] };
    }

    // ── STEP 2: Cache lookup ──────────────────────────────────────────────────
    emit('cache', 'running');
    const cacheResult = await cacheGet(question, dept);
    if (cacheResult.hit) {
      emit('cache', 'hit', { detail: cacheResult.type });
      const latencyMs = Date.now() - start;
      logRequest({ ...logEntry, answer: cacheResult.answer, cacheHit: cacheResult.type, latencyMs, verdict: 'CACHE_HIT' });
      return { answer: cacheResult.answer, sources: [], validated: true, cacheHit: cacheResult.type, latencyMs, verdict: 'CACHE_HIT', claims: [] };
    }
    emit('cache', 'miss');

    // ── STEP 3: Embed query ───────────────────────────────────────────────────
    emit('embedding', 'running');
    const queryEmbedding = await embedOne(question);
    emit('embedding', 'done', { detail: `${queryEmbedding.length}-dim vector` });

    // ── STEP 4: Vector search ─────────────────────────────────────────────────
    emit('retrieval', 'running');
    const rawResults = await queryChunks(queryEmbedding, dept, config.retrievalTopK);
    const chunks     = rawResults.filter(r => r.score >= config.retrievalMinScore);

    if (chunks.length === 0) {
      emit('retrieval', 'empty');
      const answer    = NOT_FOUND_MSG(dept);
      const latencyMs = Date.now() - start;
      logRequest({ ...logEntry, answer, cacheHit: 'none', latencyMs, verdict: 'NOT_FOUND' });
      return { answer, sources: [], validated: false, cacheHit: 'none', latencyMs, verdict: 'NOT_FOUND', claims: [] };
    }

    emit('retrieval', 'done', {
      detail: `${chunks.length} chunks retrieved`,
      chunks: chunks.map(c => ({
        id:         c.id,
        text:       c.text.slice(0, 200),
        score:      c.score,
        sourceFile: c.metadata?.sourceFile || c.metadata?.source || '',
        sourceOrg:  c.metadata?.sourceOrg  || '',
        section:    c.metadata?.section    || '',
        sourceUrl:  c.metadata?.sourceUrl  || '',
      })),
    });

    // ── STEP 5: Generate ──────────────────────────────────────────────────────
    emit('generation', 'running');
    let answer = await generateAnswer(question, chunks, {}, onToken);
    emit('generation', 'done', { detail: `${answer.length} chars` });

    // ── STEP 6: Validate ──────────────────────────────────────────────────────
    let verdict   = 'PASS';
    let validated = true;
    let claims    = [];
    const chunkIds = chunks.map(c => c.id);

    if (process.env.VALIDATE_REQUESTS !== 'false') {
      emit('validation', 'running');
      const validation = await validate(question, chunks, answer);
      verdict = validation.verdict;
      claims  = validation.claims || [];
      emit('validation', verdict === 'PASS' ? 'pass' : 'fail', {
        detail:  `${claims.length} claims checked`,
        claims,
        unsupportedClaims: validation.unsupportedClaims,
      });

      if (verdict === 'FAIL') {
        console.warn('[pipeline] Validator FAILED — regenerating with constraints…');
        emit('generation', 'running', { detail: 'Regenerating (constrained)' });
        // Do NOT pass onToken here — prevents duplicate streaming into the same bubble
        answer = await generateAnswer(question, chunks, { unsupportedClaims: validation.unsupportedClaims }, null);
        emit('generation', 'done', { detail: 'Regenerated' });

        emit('validation', 'running', { detail: 'Re-validating' });
        const revalidation = await validate(question, chunks, answer);
        verdict = revalidation.verdict;
        claims  = revalidation.claims || [];
        emit('validation', verdict === 'PASS' ? 'pass' : 'fail', {
          detail: 'Re-validation complete',
          claims,
          unsupportedClaims: revalidation.unsupportedClaims,
        });

        if (verdict === 'FAIL') {
          // Validator failed twice — deliver the regenerated answer anyway rather than
          // the generic safe fallback. Mark as FAIL so the UI shows the warning badge.
          const latencyMs = Date.now() - start;
          emit('reply', 'sent', { detail: 'Delivered with validation warning' });
          logRequest({ ...logEntry, chunkIds, answer, verdict: 'FAIL', cacheHit: 'none', latencyMs });
          return { answer, sources: buildSourcesPayload(chunks), validated: false, cacheHit: 'none', latencyMs, verdict: 'FAIL', claims };
        }
      }
    }

    // ── STEP 7: Cache write ───────────────────────────────────────────────────
    if (verdict === 'PASS') {
      await cacheSet(question, dept, answer);
    }

    // ── STEP 8: Log & reply ───────────────────────────────────────────────────
    const latencyMs = Date.now() - start;
    logRequest({ ...logEntry, chunkIds, answer, verdict, cacheHit: 'none', latencyMs });
    emit('reply', 'sent', { detail: `${latencyMs}ms total` });

    return { answer, sources: buildSourcesPayload(chunks), validated, cacheHit: 'none', latencyMs, verdict, claims };

  } catch (err) {
    const latencyMs = Date.now() - start;
    console.error('[pipeline] Unhandled error:', err.message);
    emit('reply', 'error', { detail: err.message });
    logRequest({ ...logEntry, cacheHit: 'none', latencyMs, error: err.message });
    return { answer: SAFE_FALLBACK, sources: [], validated: false, cacheHit: 'none', latencyMs, verdict: 'ERROR', claims: [] };
  }
}
