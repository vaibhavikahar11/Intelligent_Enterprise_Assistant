/**
 * cache.js – Two-layer cache scoped by department.
 * Layer 1: Exact match (hash of normalised question + department)
 * Layer 2: Semantic match (cosine similarity of query embedding)
 *
 * Falls back to an in-memory mock (ioredis-mock) if Redis is unreachable,
 * so the app runs end-to-end even without a Redis server installed.
 * Only answers that PASSED validation are cached.
 */
import crypto from 'crypto';
import { embedOne } from './llm.js';
import config from '../config.js';

let _redis = null;

async function getRedis() {
  if (_redis) return _redis;

  // Try real Redis first
  try {
    const Redis = (await import('ioredis')).default;
    const client = new Redis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      retryStrategy: () => null,
    });
    client.on('error', () => {}); // swallow connection errors during probe
    await client.connect();
    await client.ping();
    console.log('[cache] Connected to Redis');
    _redis = client;
    _redis.removeAllListeners('error');
    _redis.on('error', (err) => console.warn('[cache] Redis error:', err.message));
    return _redis;
  } catch {
    console.warn('[cache] Redis unavailable — using in-memory mock (cache resets on restart)');
    const RedisMock = (await import('ioredis-mock')).default;
    _redis = new RedisMock();
    return _redis;
  }
}

/** Normalise a question for consistent hashing. */
function normalise(q) {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Exact cache key. */
function exactKey(question, department) {
  const hash = crypto
    .createHash('sha256')
    .update(`${normalise(question)}::${department.toUpperCase()}`)
    .digest('hex')
    .slice(0, 16);
  return `iea:exact:${department.toUpperCase()}:${hash}`;
}

/** Semantic cache list key. */
function semanticListKey(department) {
  return `iea:semantic:${department.toUpperCase()}`;
}

/** Cosine similarity between two vectors. */
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Look up a question in the cache.
 * @returns {Promise<{hit: boolean, type: 'exact'|'semantic'|'none', answer?: string}>}
 */
export async function cacheGet(question, department) {
  const redis = await getRedis();

  // Layer 1: Exact
  try {
    const key = exactKey(question, department);
    const cached = await redis.get(key);
    if (cached) return { hit: true, type: 'exact', answer: cached };
  } catch (err) {
    console.warn('[cache] Exact cache error:', err.message);
  }

  // Layer 2: Semantic
  try {
    const listKey = semanticListKey(department);
    const raw = await redis.lrange(listKey, 0, 99);
    if (raw.length > 0) {
      const queryEmbedding = await embedOne(question);
      for (const item of raw) {
        let entry;
        try { entry = JSON.parse(item); } catch { continue; }
        const sim = cosineSim(queryEmbedding, entry.embedding);
        if (sim >= config.cacheSimThreshold) {
          return { hit: true, type: 'semantic', answer: entry.answer };
        }
      }
    }
  } catch (err) {
    console.warn('[cache] Semantic cache error:', err.message);
  }

  return { hit: false, type: 'none' };
}

/**
 * Store a validated answer in both cache layers.
 */
export async function cacheSet(question, department, answer, embedding = null) {
  const redis = await getRedis();
  const ttl = config.cacheTtlSeconds;

  // Layer 1: Exact
  try {
    const key = exactKey(question, department);
    await redis.setex(key, ttl, answer);
  } catch (err) {
    console.warn('[cache] Exact cache write error:', err.message);
  }

  // Layer 2: Semantic
  try {
    const vec = embedding || (await embedOne(question));
    const entry = JSON.stringify({ embedding: vec, answer, timestamp: Date.now() });
    const listKey = semanticListKey(department);
    await redis.lpush(listKey, entry);
    await redis.ltrim(listKey, 0, 99);
    await redis.expire(listKey, ttl);
  } catch (err) {
    console.warn('[cache] Semantic cache write error:', err.message);
  }
}

/**
 * Invalidate all cache entries for a department.
 */
export async function invalidateDepartment(department) {
  const redis = await getRedis();
  const dept = department.toUpperCase();
  try {
    await redis.del(semanticListKey(dept));
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor, 'MATCH', `iea:exact:${dept}:*`, 'COUNT', 100
      );
      cursor = nextCursor;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
    console.log(`[cache] Invalidated cache for department: ${dept}`);
  } catch (err) {
    console.warn('[cache] Invalidation error:', err.message);
  }
}

/**
 * Health check for Redis.
 */
export async function healthCheck() {
  try {
    const redis = await getRedis();
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
