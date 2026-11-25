/**
 * ingest.js – Document ingestion pipeline (Phase 2 – Real Data).
 *
 * Features:
 *  • Supports .txt, .md, .pdf, .html / .htm
 *  • Recurses into subdirectories; department = top-level folder name
 *  • Source organisation derived from immediate subfolder OR docs/SOURCES.md table
 *  • Original URL read from docs/SOURCES.md table (keyed by relative path from dept dir)
 *  • Strips HTML nav/header/footer boilerplate; strips MD front-matter & link refs
 *  • Skips images, binaries, and docs/SOURCES.md / docs/Source.md themselves
 *  • Prints summary: files processed, chunks per dept, skipped files + reasons
 *
 * Usage:
 *   node scripts/ingest.js                   # all departments
 *   node scripts/ingest.js --dept hr         # one department only
 *   node scripts/ingest.js --force           # delete vectors.json and re-ingest
 *   node scripts/ingest.js --skip-pdf-vision # skip image PDFs (use when Gemini 503)
 *   node scripts/ingest.js --pdf-only        # only process image PDFs (retry pass)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import '../src/config.js';
import { embed }                       from '../src/services/llm.js';
import { upsertChunks, deleteBySource } from '../src/services/vectorStore.js';
import { invalidateDepartment }        from '../src/services/cache.js';
import { GoogleGenerativeAI }          from '@google/generative-ai';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR   = path.resolve(__dirname, '../docs');
const VECTORS_FILE = path.resolve(__dirname, '../chroma_data/vectors.json');

// ─── Tuning constants ─────────────────────────────────────────────────────────
const CHUNK_SIZE    = 500;   // target tokens (~4 chars/token)
const CHUNK_OVERLAP = 50;    // overlap in tokens
const BATCH_SIZE    = 5;     // embedding API calls per batch

const CHAR_CHUNK   = CHUNK_SIZE    * 4;
const CHAR_OVERLAP = CHUNK_OVERLAP * 4;

// Extensions we will process
const SUPPORTED_EXTS = new Set(['.txt', '.md', '.pdf', '.html', '.htm']);

// Extensions we silently skip (binary / media)
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.ogg', '.flac',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.bin', '.obj',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.db', '.sqlite', '.sqlite3',
  '.pyc', '.class',
]);

// Files at the docs/ root to skip (meta files, not content)
const SKIP_BASENAMES = new Set(['SOURCES.md', 'Source.md', 'README.md', '.gitkeep']);

// ─── SOURCES.md parser ────────────────────────────────────────────────────────
/**
 * Parses docs/SOURCES.md (or docs/Source.md) markdown tables.
 * Returns a Map keyed by normalised filename  →  { org, url }
 *
 * Table format expected (any section):
 *   | File (exact filename on disk) | Organization | Source URL |
 *   |---|---|---|
 *   | hr/foo.pdf | Acme Corp | https://... |
 *
 * Keys are lowercased basenames (or relative paths from dept dir).
 */
function parseSources() {
  const candidates = [
    path.join(DOCS_DIR, 'SOURCES.md'),
    path.join(DOCS_DIR, 'Source.md'),
  ];
  const sourceFile = candidates.find((f) => fs.existsSync(f));
  if (!sourceFile) return new Map();

  const lines = fs.readFileSync(sourceFile, 'utf-8').split('\n');
  const map   = new Map();

  for (const line of lines) {
    // Match a markdown table row with at least 3 pipe-separated cells
    const cells = line.split('|').map((s) => s.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    const [rawFile, org, url] = cells;

    // Skip header rows and separator rows
    if (!org || !url) continue;
    if (rawFile.toLowerCase().startsWith('file') || rawFile.startsWith('---')) continue;
    if (url === 'Source URL' || url.startsWith('---')) continue;

    const normalKey = path.basename(rawFile).toLowerCase();
    map.set(normalKey, { org: org.trim(), url: url.trim() });

    // Also store by the full relative sub-path so deeper files resolve correctly
    const subKey = rawFile.replace(/\\/g, '/').toLowerCase().trim();
    map.set(subKey, { org: org.trim(), url: url.trim() });
  }

  console.log(`[ingest] Loaded ${map.size / 2 | 0} source entries from ${path.basename(sourceFile)}`);
  return map;
}

// ─── Gemini multimodal client (for image-based PDF fallback) ──────────────────
const _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Extract text from an image-based PDF using Gemini multimodal.
 * Falls back when pdf-parse returns no usable text.
 */
async function extractPdfViaGemini(filePath) {
  const model = _genAI.getGenerativeModel({
    model: process.env.GEN_MODEL || 'gemini-3.5-flash-lite',
    generationConfig: { maxOutputTokens: 8192 },
  });
  const pdfBytes = fs.readFileSync(filePath);
  const b64 = pdfBytes.toString('base64');
  let delay = 5000;
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const result = await model.generateContent([
        { inlineData: { mimeType: 'application/pdf', data: b64 } },
        'Extract all text from this PDF document exactly as written. ' +
        'Preserve headings, bullet points, and numbered lists. ' +
        'Output only the extracted text, no commentary, no markdown code fences.',
      ]);
      return result.response.text();
    } catch (err) {
      if (attempt === 6) throw err;
      // Respect explicit retry-after header hint
      const retryMatch = err.message?.match(/retry[^0-9]*(\d+)/i);
      const wait = retryMatch
        ? parseInt(retryMatch[1], 10) * 1000
        : delay;
      console.warn(`[ingest] Gemini PDF extraction failed (attempt ${attempt + 1}), retrying in ${Math.round(wait / 1000)}s…`);
      await new Promise((r) => setTimeout(r, wait));
      delay = Math.min(delay * 2, 60000); // cap at 60s
    }
  }
}

// ─── Text extraction ──────────────────────────────────────────────────────────

/** Strip HTML: remove tags, collapse whitespace, drop nav/header/footer blocks. */
function extractHtml(html) {
  // Remove entire nav / header / footer / script / style blocks
  let text = html
    .replace(/<(nav|header|footer|script|style|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ');
  return text;
}

/** Strip MD boilerplate: front-matter, link reference definitions, image syntax. */
function extractMarkdown(md) {
  let text = md;
  // Remove YAML front-matter
  if (text.startsWith('---')) {
    const end = text.indexOf('---', 3);
    if (end !== -1) text = text.slice(end + 3);
  }
  // Remove link reference definitions: [label]: url "title"
  text = text.replace(/^\[.+?\]:\s+https?:\/\/\S+.*$/gm, '');
  // Convert images to alt text only
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  return text;
}

/** Read and extract plain text from a file. */
async function readFileContent(filePath, { skipPdfVision = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();

  // ── Non-PDF files: straightforward read ────────────────────────────────────
  if (ext !== '.pdf') {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (ext === '.html' || ext === '.htm') return extractHtml(raw);
    if (ext === '.md')                     return extractMarkdown(raw);
    return raw; // .txt
  }

  // ── PDF: try native text layer first ───────────────────────────────────────
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buffer   = fs.readFileSync(filePath);
    const data     = await pdfParse(buffer);
    if (data.text && data.text.trim().length >= 50) {
      return data.text; // text-layer PDF — done
    }
  } catch (_) { /* image-based or corrupt — fall through */ }

  // ── Image-based PDF: use Gemini vision or skip ─────────────────────────────
  if (skipPdfVision) {
    throw new Error('Image-based PDF — run "node scripts/ingest.js --pdf-only" later to embed via Gemini vision');
  }
  console.log(`[ingest]     (image PDF — using Gemini vision extraction)`);
  return extractPdfViaGemini(filePath);
}

// ─── Text cleaning & chunking ─────────────────────────────────────────────────

function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g,   '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n')
    .trim();
}

function extractSection(text) {
  const lines = text.trim().split('\n');
  for (const line of lines.slice(0, 3)) {
    if (line.match(/^[A-Z][^.?!]{3,60}$/) || line.match(/^#{1,3} /)) {
      return line.replace(/^#+\s*/, '').trim().slice(0, 80);
    }
  }
  return '';
}

function generateChunkId(source, index) {
  return `${source.replace(/[^a-z0-9]/gi, '_')}_chunk_${index}`;
}

/**
 * Split text into overlapping chunks.
 * metadata includes: department, source, section, chunkIndex,
 *                    sourceOrg, sourceUrl, sourceFile, sourcePath
 */
function chunkText(text, metadata) {
  const { department, source, sourceOrg, sourceUrl, sourceFile, sourcePath } = metadata;
  const paragraphs = text.split(/\n\n+/);
  const chunks     = [];
  let buffer       = '';
  let chunkIndex   = 0;

  const makeChunk = (buf) => ({
    id:   generateChunkId(source, chunkIndex),
    text: buf.trim(),
    metadata: {
      department,
      source,
      sourceFile,
      sourcePath,
      sourceOrg: sourceOrg || '',
      sourceUrl: sourceUrl || '',
      section:   extractSection(buf),
      chunkIndex,
    },
  });

  for (const para of paragraphs) {
    if ((buffer + '\n\n' + para).length > CHAR_CHUNK && buffer.length > 0) {
      chunks.push(makeChunk(buffer));
      chunkIndex++;
      const words       = buffer.split(' ');
      const overlapWords = words.slice(-Math.floor(CHAR_OVERLAP / 5));
      buffer = overlapWords.join(' ') + '\n\n' + para;
    } else {
      buffer = buffer ? buffer + '\n\n' + para : para;
    }
  }

  if (buffer.trim()) {
    chunks.push(makeChunk(buffer));
  }

  return chunks;
}

// ─── Embedding ────────────────────────────────────────────────────────────────

async function embedBatch(chunks) {
  const texts   = chunks.map((c) => c.text);
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const allEmbeddings = [];
  for (const batch of batches) {
    let delay = 1000;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const embeddings = await embed(batch);
        allEmbeddings.push(...embeddings);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        // Honour Gemini "retry in Xs" header
        const retryMatch = err.message?.match(/retry[^0-9]*(\d+)/i);
        const wait       = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : delay;
        console.warn(`[ingest] Embed batch failed (attempt ${attempt + 1}), retrying in ${wait}ms…`);
        await new Promise((r) => setTimeout(r, wait));
        delay *= 2;
      }
    }
  }
  return allEmbeddings;
}

// ─── File walker ─────────────────────────────────────────────────────────────

/**
 * Recursively collect all files under dir.
 * Returns array of absolute paths.
 */
function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Derive source organisation from the immediate subdirectory under deptDir.
 * e.g.  docs/hr/handbook-master/… → "handbook-master"
 *       docs/hr/foo.pdf            → '' (file directly in dept dir)
 */
function deriveOrgFromPath(filePath, deptDir) {
  const rel     = path.relative(deptDir, filePath);
  const parts   = rel.split(path.sep);
  return parts.length > 1 ? parts[0] : '';
}

// ─── Single-file processor ────────────────────────────────────────────────────

/** Process one file: extract → clean → chunk → embed → upsert. */
async function processFile(filePath, department, deptDir, sourcesMap, opts = {}) {
  const relFromDept = path.relative(deptDir, filePath).replace(/\\/g, '/');
  const sourceFile  = path.basename(filePath);
  const sourcePath  = `${department}/${relFromDept}`;

  // --- Look up org + url from SOURCES.md (try full rel path first, then basename)
  const lookupKeys = [
    relFromDept.toLowerCase(),
    sourceFile.toLowerCase(),
    // Also try with dept prefix
    `${department}/${relFromDept}`.toLowerCase(),
  ];
  let sourceOrg = deriveOrgFromPath(filePath, deptDir); // fallback: subfolder name
  let sourceUrl = '';

  for (const key of lookupKeys) {
    if (sourcesMap.has(key)) {
      const entry = sourcesMap.get(key);
      sourceOrg   = entry.org  || sourceOrg;
      sourceUrl   = entry.url  || sourceUrl;
      break;
    }
  }

  // Clean up org: for files directly in dept dir with no SOURCES entry,
  // try to infer org from PDF filename pattern  "GitLab_handbook_…" → "GitLab"
  // Only do this for PDFs — TXTs/MDs get org = '' (direct company doc)
  if (!sourceOrg) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      const orgMatch = sourceFile.match(/^([A-Za-z][A-Za-z0-9]+)[_\-]/);
      if (orgMatch) sourceOrg = orgMatch[1];
    }
  }

  console.log(`[ingest]   Processing: ${sourcePath}`);

  const raw   = await readFileContent(filePath, opts);
  const clean = cleanText(raw);

  if (clean.length < 50) {
    throw new Error(`Content too short after extraction (${clean.length} chars) – likely empty or corrupt`);
  }

  const chunks = chunkText(clean, {
    department: department.toUpperCase(),
    source:     sourceFile,
    sourceFile,
    sourcePath,
    sourceOrg,
    sourceUrl,
  });

  if (chunks.length === 0) throw new Error('No chunks produced');

  // Idempotent: delete old chunks for this source first
  await deleteBySource(sourceFile);

  const embeddings = await embedBatch(chunks);
  const enriched   = chunks.map((c, i) => ({ ...c, embedding: embeddings[i] }));
  await upsertChunks(enriched);

  return { chunks: chunks.length, sourceOrg, sourceUrl };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function main() {
  const args       = process.argv.slice(2);
  const deptArg    = args.find((a) => a.startsWith('--dept'));
  const filterDept = deptArg
    ? (deptArg.includes('=') ? deptArg.split('=')[1] : args[args.indexOf(deptArg) + 1])
    : null;
  const force         = args.includes('--force');
  const skipPdfVision = args.includes('--skip-pdf-vision'); // skip image PDFs
  const pdfOnly       = args.includes('--pdf-only');       // only image PDFs

  if (force && fs.existsSync(VECTORS_FILE)) {
    fs.unlinkSync(VECTORS_FILE);
    console.log('[ingest] --force: deleted existing vectors.json');
  }

  // Auto-discover departments = any immediate subdirectory of docs/
  const allDepts = fs.readdirSync(DOCS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const departments = filterDept
    ? allDepts.filter((d) => d.toLowerCase() === filterDept.toLowerCase())
    : allDepts;

  if (departments.length === 0) {
    console.error('[ingest] No department directories found under', DOCS_DIR);
    return;
  }

  // Load SOURCES.md
  const sourcesMap = parseSources();

  // ── Summary accumulators ──
  const summary = {
    byDept:  {},   // { dept: { files: n, chunks: n } }
    skipped: [],   // [ { file, reason } ]
    total:   { files: 0, chunks: 0 },
  };

  const processedDepts = new Set();

  for (const dept of departments) {
    const deptDir = path.join(DOCS_DIR, dept);
    if (!fs.existsSync(deptDir)) {
      console.warn(`[ingest] Skipping missing directory: ${deptDir}`);
      continue;
    }

    const allFiles = walkDir(deptDir);
    if (allFiles.length === 0) {
      console.log(`[ingest] [${dept.toUpperCase()}] No files found.`);
      continue;
    }

    console.log(`\n[ingest] ═══ Department: ${dept.toUpperCase()} (${allFiles.length} files found) ═══`);
    summary.byDept[dept.toUpperCase()] = { files: 0, chunks: 0 };

    for (const filePath of allFiles) {
      const baseName = path.basename(filePath);
      const ext      = path.extname(filePath).toLowerCase();
      const relPath  = path.relative(DOCS_DIR, filePath).replace(/\\/g, '/');
      const isPdf    = ext === '.pdf';

      // Skip meta/source files
      if (SKIP_BASENAMES.has(baseName)) {
        summary.skipped.push({ file: relPath, reason: 'meta/source file — skipped intentionally' });
        continue;
      }

      // Skip binary / media
      if (BINARY_EXTS.has(ext)) {
        summary.skipped.push({ file: relPath, reason: `binary/media extension (${ext})` });
        continue;
      }

      // Skip unsupported text formats
      if (!SUPPORTED_EXTS.has(ext)) {
        summary.skipped.push({ file: relPath, reason: `unsupported extension (${ext})` });
        continue;
      }

      // --pdf-only: skip non-PDF files (they're already embedded)
      if (pdfOnly && !isPdf) {
        continue;
      }

      try {
        const result = await processFile(filePath, dept, deptDir, sourcesMap, { skipPdfVision });
        summary.byDept[dept.toUpperCase()].files  += 1;
        summary.byDept[dept.toUpperCase()].chunks += result.chunks;
        summary.total.files  += 1;
        summary.total.chunks += result.chunks;
        processedDepts.add(dept.toUpperCase());
        console.log(`[ingest]     → ${result.chunks} chunks | org: ${result.sourceOrg || '(direct)'}`);
      } catch (err) {
        summary.skipped.push({ file: relPath, reason: err.message });
        console.warn(`[ingest]     ✗ Skipped: ${err.message}`);
      }
    }
  }

  // Invalidate semantic cache for re-ingested departments
  for (const dept of processedDepts) {
    await invalidateDepartment(dept);
  }

  // ── Print final summary ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  IEA INGESTION SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Total files processed : ${summary.total.files}`);
  console.log(`  Total chunks stored   : ${summary.total.chunks}`);
  console.log('');
  console.log('  By department:');
  for (const [dept, stat] of Object.entries(summary.byDept)) {
    console.log(`    ${dept.padEnd(12)} ${stat.files} files  →  ${stat.chunks} chunks`);
  }

  if (summary.skipped.length > 0) {
    console.log('');
    console.log(`  Skipped (${summary.skipped.length}):`)
    for (const s of summary.skipped) {
      console.log(`    ✗  ${s.file}`);
      console.log(`       Reason: ${s.reason}`);
    }
  }

  console.log('═'.repeat(60));
  console.log('  ✓ Ingestion complete!\n');
}

export { main as ingestMain };

// Auto-run when executed directly
const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error('[ingest] Fatal error:', err);
    process.exit(1);
  });
}
