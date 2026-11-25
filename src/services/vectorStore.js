/**
 * vectorStore.js – ChromaDB client wrapper with in-memory fallback.
 *
 * Tries to connect to the ChromaDB HTTP server (CHROMA_URL).
 * If the server is unavailable it falls back to an in-memory vector store
 * so the app runs end-to-end without Docker or a separate server.
 *
 * ⚠️  In-memory mode: data is lost when the Node process exits.
 *     For persistent storage, run ChromaDB before starting the server:
 *       chroma run --path ./chroma_data --port 8000
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ChromaClient } from 'chromadb';
import config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_STORE_FILE = path.resolve(__dirname, '../../chroma_data/vectors.json');

const COLLECTION_NAME = 'iea_documents';

let _client     = null;
let _collection = null;
let _memStore   = null; // used in in-memory fallback mode

// ─── In-memory vector store with JSON backup ──────────────────────────────────
class InMemoryVectorStore {
  constructor() {
    /** @type {Map<string, {text: string, metadata: object, embedding: number[]}>} */
    this._docs = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(LOCAL_STORE_FILE)) {
        const raw = fs.readFileSync(LOCAL_STORE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        for (const [id, doc] of Object.entries(parsed)) {
          this._docs.set(id, doc);
        }
        console.log(`[vectorStore] Loaded ${this._docs.size} vectors from local store`);
      }
    } catch (err) {
      console.warn('[vectorStore] Could not load local vectors:', err.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(LOCAL_STORE_FILE), { recursive: true });
      const obj = Object.fromEntries(this._docs);
      fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(obj), 'utf-8');
    } catch (err) {
      console.warn('[vectorStore] Could not persist vectors:', err.message);
    }
  }

  async upsert({ ids, embeddings, documents, metadatas }) {
    for (let i = 0; i < ids.length; i++) {
      this._docs.set(ids[i], {
        text:      documents[i],
        metadata:  metadatas[i],
        embedding: embeddings[i],
      });
    }
    this._save();
  }

  async query({ queryEmbeddings, nResults, where }) {
    const qVec = queryEmbeddings[0];
    let entries = [...this._docs.entries()];

    // Apply metadata filter
    if (where) {
      entries = entries.filter(([, doc]) =>
        Object.entries(where).every(([k, v]) => doc.metadata[k] === v)
      );
    }

    // Compute cosine similarity
    const scored = entries.map(([id, doc]) => ({
      id,
      text:      doc.text,
      metadata:  doc.metadata,
      distance:  1 - cosineSim(qVec, doc.embedding),
    }));

    scored.sort((a, b) => a.distance - b.distance);
    const top = scored.slice(0, nResults);

    return {
      ids:       [top.map((r) => r.id)],
      documents: [top.map((r) => r.text)],
      metadatas: [top.map((r) => r.metadata)],
      distances: [top.map((r) => r.distance)],
    };
  }

  async delete({ where }) {
    for (const [id, doc] of this._docs.entries()) {
      if (Object.entries(where).every(([k, v]) => doc.metadata[k] === v)) {
        this._docs.delete(id);
      }
    }
    this._save();
  }

  async count() { return this._docs.size; }
}

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Collection accessor ───────────────────────────────────────────────────────
async function getCollection() {
  if (_collection) return _collection;
  if (_memStore)   return _memStore;

  // Try real ChromaDB HTTP server
  try {
    const client = new ChromaClient({ path: config.chromaUrl });
    await client.heartbeat();
    _client     = client;
    _collection = await _client.getOrCreateCollection({
      name:     COLLECTION_NAME,
      metadata: { 'hnsw:space': 'cosine' },
    });
    console.log('[vectorStore] Connected to ChromaDB at', config.chromaUrl);
    return _collection;
  } catch {
    console.warn(
      '[vectorStore] ChromaDB server not reachable — using in-memory vector store.\n' +
      '             Vectors are NOT persisted across restarts.\n' +
      '             Run "chroma run --path ./chroma_data --port 8000" for persistence.'
    );
    _memStore = new InMemoryVectorStore();
    return _memStore;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export async function upsertChunks(chunks) {
  const col = await getCollection();
  await col.upsert({
    ids:        chunks.map((c) => c.id),
    embeddings: chunks.map((c) => c.embedding),
    documents:  chunks.map((c) => c.text),
    metadatas:  chunks.map((c) => c.metadata),
  });
}

export async function queryChunks(embedding, department, topK) {
  const col   = await getCollection();
  const where = department ? { department: department.toUpperCase() } : undefined;

  const results = await col.query({
    queryEmbeddings: [embedding],
    nResults:        topK,
    where,
    include:         ['documents', 'metadatas', 'distances'],
  });

  const ids       = results.ids[0];
  const docs      = results.documents[0];
  const metas     = results.metadatas[0];
  const distances = results.distances[0];

  return ids.map((id, i) => ({
    id,
    text:     docs[i],
    metadata: metas[i],
    score:    1 - distances[i],
  }));
}

export async function deleteBySource(source) {
  const col = await getCollection();
  try {
    await col.delete({ where: { source } });
  } catch (err) {
    if (!err.message?.includes('no documents') &&
        !err.message?.includes('NotFound')) throw err;
  }
  // Also delete by sourceFile key (Phase 2 metadata)
  try {
    await col.delete({ where: { sourceFile: source } });
  } catch (_) { /* ignore */ }
}

export async function healthCheck() {
  try { await getCollection(); return true; } catch { return false; }
}

export async function getCount() {
  const col = await getCollection();
  return col.count();
}
