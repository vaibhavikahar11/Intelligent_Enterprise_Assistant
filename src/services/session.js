/**
 * session.js – Stores the department selection per WhatsApp number.
 * Phone numbers are SHA-256 hashed before use as keys.
 *
 * Falls back to an in-memory Map if Redis is unreachable,
 * so WhatsApp sessions still work without a Redis server.
 */
import crypto from 'crypto';
import config from '../config.js';

// In-memory fallback store
const _memoryStore = new Map();
const _memoryTtl   = new Map();
const SESSION_TTL  = 60 * 60 * 24 * 1000; // 24 hours in ms

let _redis = null;
let _useMemory = false;

async function getRedis() {
  if (_redis) return _redis;
  if (_useMemory) return null;

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
    console.log('[session] Connected to Redis');
    _redis = client;
    _redis.removeAllListeners('error');
    _redis.on('error', (err) => console.warn('[session] Redis error:', err.message));
    return _redis;
  } catch {
    console.warn('[session] Redis unavailable — using in-memory session store');
    _useMemory = true;
    return null;
  }
}

function hashPhone(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 20);
}

/** Get the stored department for a phone number. */
export async function getDepartment(phone) {
  const key = `iea:session:${hashPhone(phone)}`;
  const redis = await getRedis();
  if (_useMemory) {
    const exp = _memoryTtl.get(key);
    if (exp && Date.now() > exp) { _memoryStore.delete(key); _memoryTtl.delete(key); return null; }
    return _memoryStore.get(key) || null;
  }
  return redis.get(key);
}

/** Set the department for a phone number. */
export async function setDepartment(phone, department) {
  const key = `iea:session:${hashPhone(phone)}`;
  const redis = await getRedis();
  if (_useMemory) {
    _memoryStore.set(key, department.toUpperCase());
    _memoryTtl.set(key, Date.now() + SESSION_TTL);
    return;
  }
  await redis.setex(key, 60 * 60 * 24, department.toUpperCase());
}

/** Clear the session (when user sends 'menu'). */
export async function clearDepartment(phone) {
  const key = `iea:session:${hashPhone(phone)}`;
  const redis = await getRedis();
  if (_useMemory) { _memoryStore.delete(key); _memoryTtl.delete(key); return; }
  await redis.del(key);
}
