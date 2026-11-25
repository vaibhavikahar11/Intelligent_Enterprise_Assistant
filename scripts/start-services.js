/**
 * start-services.js
 * Starts ChromaDB (via Python chroma CLI) as a background process.
 * Run this once before starting the IEA server when Docker is not available.
 *
 * Usage: node scripts/start-services.js
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROMA_DATA = path.join(ROOT, 'chroma_data');

fs.mkdirSync(CHROMA_DATA, { recursive: true });

console.log('Starting ChromaDB on http://localhost:8000 ...');

const chroma = spawn(
  'chroma',
  ['run', '--path', CHROMA_DATA, '--port', '8000'],
  {
    stdio: 'inherit',
    shell: true,
    cwd: ROOT,
    env: { ...process.env },
  }
);

chroma.on('error', (err) => {
  console.error('ChromaDB failed to start:', err.message);
  console.error('Make sure chromadb is installed: pip install chromadb');
  process.exit(1);
});

chroma.on('exit', (code) => {
  if (code !== 0) console.error(`ChromaDB exited with code ${code}`);
});

console.log('ChromaDB process started (PID will show above).');
console.log('Press Ctrl+C to stop.');

// Keep the script alive
process.on('SIGINT', () => {
  console.log('\nShutting down ChromaDB...');
  chroma.kill();
  process.exit(0);
});
