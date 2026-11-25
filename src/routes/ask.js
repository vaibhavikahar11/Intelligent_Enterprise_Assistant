/**
 * ask.js – REST API routes.
 * POST /ask    – Run the full RAG pipeline
 * GET  /health – Check Redis and ChromaDB connectivity
 */
import { Router } from 'express';
import { runPipeline } from '../pipeline.js';
import { healthCheck as redisHealth } from '../services/cache.js';
import { healthCheck as chromaHealth } from '../services/vectorStore.js';

const router = Router();

/**
 * POST /ask
 * Body: { question: string, department: 'HR' | 'IT' }
 * Returns: { answer, sources, validated, cacheHit, latencyMs, verdict }
 */
router.post('/ask', async (req, res) => {
  const { question, department } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required and must be a string.' });
  }

  const dept = (department || '').toUpperCase();
  if (!['HR', 'IT'].includes(dept)) {
    return res.status(400).json({ error: 'department must be "HR" or "IT".' });
  }

  try {
    const result = await runPipeline({
      question: question.trim(),
      department: dept,
      channel: 'api',
    });
    return res.json(result);
  } catch (err) {
    console.error('[ask] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /health
 * Returns live status of Redis and ChromaDB.
 */
router.get('/health', async (_req, res) => {
  const [redisResult, chromaResult] = await Promise.allSettled([
    redisHealth(),
    chromaHealth(),
  ]);

  const services = {
    redis: redisResult.value === true ? 'up' : 'down',
    chroma: chromaResult.value === true ? 'up' : 'down',
  };

  const allUp = Object.values(services).every((s) => s === 'up');

  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services,
  });
});

export default router;
