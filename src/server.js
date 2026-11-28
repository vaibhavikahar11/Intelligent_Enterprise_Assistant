/**
 * server.js – Express + WebSocket bootstrap.
 * Sets up middleware, routes, WebSocket server, and starts listening.
 */
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import config from './config.js';
import askRouter from './routes/ask.js';
import whatsappRouter from './routes/whatsapp.js';
import { handleWebSocket } from './ws/chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1);
const httpServer = createServer(app);

// ─── Security middleware ──────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
  })
);
app.use(cors());

// ─── Rate limiting ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 60,                   // 60 requests per minute per IP
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/ask', apiLimiter);
app.use('/whatsapp', apiLimiter);

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ─── Static files (web chat UI) ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.use('/', askRouter);
app.use('/whatsapp', whatsappRouter);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', handleWebSocket);

wss.on('error', (err) => {
  console.error('[wss] WebSocket server error:', err.message);
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    const { getCount } = await import('./services/vectorStore.js');
    const count = await getCount();
    if (count === 0) {
      console.log('[server] Vector store empty — loading documents...');
      const { main: ingestMain } = await import('../scripts/ingest.js');
      await ingestMain();
      console.log('[server] ✓ Documents ready');
    } else {
      console.log(`[server] ✓ Vector store ready (${count} chunks loaded)`);
    }
  } catch (err) {
    console.warn('[server] ⚠ Ingest warning (continuing):', err.message);
  }

  httpServer.listen(config.port, () => {
    console.log(`[server] ✓ IEA running   → http://localhost:${config.port}`);
    console.log(`[server] ✓ WebSocket     → ws://localhost:${config.port}/ws`);
    console.log(`[server] ✓ Web chat UI   → http://localhost:${config.port}`);
    console.log(`[server] ✓ Health check  → http://localhost:${config.port}/health`);
  });
}

start();

export default app;

