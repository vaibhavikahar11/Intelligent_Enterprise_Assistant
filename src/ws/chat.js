/**
 * chat.js – WebSocket handler for the web chat interface.
 *
 * Protocol (JSON messages):
 *   Client → Server: { type: 'ask', question: string, department: 'HR'|'IT' }
 *
 *   Server → Client:
 *     { type: 'welcome', message }
 *     { type: 'stage',   stage, status, durationMs, detail?, chunks?, claims? }
 *     { type: 'token',   text }           ← streaming LLM tokens
 *     { type: 'answer',  answer, sources, validated, cacheHit, latencyMs, verdict, claims }
 *     { type: 'error',   message }
 */
import { runPipeline } from '../pipeline.js';

export function handleWebSocket(ws, req) {
  const ip = req.socket.remoteAddress || 'unknown';
  console.log(`[ws] New connection from ${ip}`);

  const session = { department: null, busy: false };

  send(ws, {
    type: 'welcome',
    message: 'Connected to IEA. Send { type: "ask", question: "...", department: "HR"|"IT" }',
  });

  ws.on('message', async (rawData) => {
    if (session.busy) {
      send(ws, { type: 'error', message: 'A request is already in progress. Please wait.' });
      return;
    }

    let msg;
    try { msg = JSON.parse(rawData.toString()); }
    catch { send(ws, { type: 'error', message: 'Invalid JSON.' }); return; }

    if (msg.type !== 'ask') {
      send(ws, { type: 'error', message: 'Unknown message type.' });
      return;
    }

    const { question, department } = msg;
    if (!question || typeof question !== 'string' || !question.trim()) {
      send(ws, { type: 'error', message: '"question" must be a non-empty string.' });
      return;
    }
    const dept = (department || '').toUpperCase();
    if (!['HR', 'IT'].includes(dept)) {
      send(ws, { type: 'error', message: '"department" must be "HR" or "IT".' });
      return;
    }

    session.department = dept;
    session.busy = true;

    // ── stage event callback ──────────────────────────────────────────────────
    function onStage(event) {
      send(ws, { type: 'stage', ...event });
    }

    // ── streaming token callback ──────────────────────────────────────────────
    function onToken(text) {
      send(ws, { type: 'token', text });
    }

    try {
      const result = await runPipeline({
        question:   question.trim(),
        department: dept,
        channel:    'web',
        onStage,
        onToken,
      });

      if (ws.readyState === ws.OPEN) {
        send(ws, { type: 'answer', ...result });
      }
    } catch (err) {
      console.error('[ws] Pipeline error:', err.message);
      if (ws.readyState === ws.OPEN) {
        send(ws, { type: 'error', message: 'An error occurred while processing your request.' });
      }
    } finally {
      session.busy = false;
    }
  });

  ws.on('close', (code) => console.log(`[ws] Connection closed — code: ${code}`));
  ws.on('error', (err)  => console.error('[ws] Socket error:', err.message));
}

function send(ws, data) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
  } catch (err) {
    console.error('[ws] Send error:', err.message);
  }
}
