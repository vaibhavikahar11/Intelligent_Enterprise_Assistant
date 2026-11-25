/**
 * logger.js – SQLite request log.
 *
 * Uses the built-in `node:sqlite` module (available in Node.js 22.5+).
 * No native compilation required — works out-of-the-box on all platforms.
 *
 * Stores every pipeline invocation with timing and validator results.
 * Phone numbers are stored as SHA-256 hashes (never raw PII).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  console.warn('[logger] node:sqlite unavailable — request logging disabled:', err.message);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.resolve(__dirname, '../../logs/iea.sqlite');

let _db = null;

function getDb() {
  if (!DatabaseSync) return null;
  if (_db) return _db;

  // Ensure the logs directory exists (synchronous, safe at startup)
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new DatabaseSync(DB_PATH);

  // WAL mode for better write concurrency
  _db.exec('PRAGMA journal_mode = WAL;');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      hashed_phone TEXT,
      channel      TEXT    NOT NULL,
      department   TEXT,
      question     TEXT    NOT NULL,
      chunk_ids    TEXT,
      answer       TEXT,
      verdict      TEXT,
      cache_hit    TEXT    NOT NULL DEFAULT 'none',
      latency_ms   INTEGER,
      error        TEXT
    )
  `);

  return _db;
}

/**
 * Log a pipeline result.
 * @param {object} entry
 * @param {string}   [entry.phone]       Raw phone number (will be hashed)
 * @param {string}   [entry.channel]     'whatsapp' | 'web' | 'api' | 'eval'
 * @param {string}   [entry.department]  'HR' | 'IT'
 * @param {string}    entry.question
 * @param {string[]} [entry.chunkIds]
 * @param {string}   [entry.answer]
 * @param {string}   [entry.verdict]     'PASS' | 'FAIL' | 'NOT_FOUND' | etc.
 * @param {string}   [entry.cacheHit]    'exact' | 'semantic' | 'none'
 * @param {number}   [entry.latencyMs]
 * @param {string}   [entry.error]
 */
export function logRequest(entry) {
  try {
    const db = getDb();
    if (!db) return;

    const hashedPhone = entry.phone
      ? crypto.createHash('sha256').update(entry.phone).digest('hex').slice(0, 20)
      : null;

    const stmt = db.prepare(`
      INSERT INTO request_log
        (hashed_phone, channel, department, question, chunk_ids, answer, verdict, cache_hit, latency_ms, error)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      hashedPhone,
      entry.channel    || 'api',
      entry.department || null,
      entry.question,
      entry.chunkIds   ? JSON.stringify(entry.chunkIds) : null,
      entry.answer     || null,
      entry.verdict    || null,
      entry.cacheHit   || 'none',
      entry.latencyMs  || null,
      entry.error      || null,
    );
  } catch (err) {
    // Never crash the pipeline due to a logging failure
    console.error('[logger] Failed to log request:', err.message);
  }
}

/**
 * Get recent log entries (for debugging / admin purposes).
 * @param {number} limit
 * @returns {object[]}
 */
export function getRecentLogs(limit = 50) {
  const db = getDb();
  if (!db) return [];
  return db
    .prepare('SELECT * FROM request_log ORDER BY id DESC LIMIT ?')
    .all(limit);
}
