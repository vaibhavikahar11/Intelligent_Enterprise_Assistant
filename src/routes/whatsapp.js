/**
 * whatsapp.js – Twilio WhatsApp webhook handler.
 *
 * Design:
 * 1. Validate the Twilio X-Twilio-Signature header to reject spoofed requests.
 * 2. Respond with empty TwiML immediately (HTTP 200) to prevent the 15-second
 *    webhook timeout.
 * 3. Process the message asynchronously and deliver the reply via the Twilio
 *    REST API (not via TwiML response body).
 *
 * Flow for a new number:
 *   → Show department menu ("1 for HR, 2 for IT")
 *   → Save choice in Redis session
 *   → Subsequent messages go straight to the RAG pipeline
 *   → Sending "menu" resets the session
 */
import { Router } from 'express';
import twilio from 'twilio';
import config from '../config.js';
import { runPipeline } from '../pipeline.js';
import { getDepartment, setDepartment, clearDepartment } from '../services/session.js';

const router = Router();

// ─── Address & signature helpers ──────────────────────────────────────────────
function normalizeWhatsAppAddress(addr) {
  const cleaned = (addr || '')
    .trim()
    .replace(/^whatsapp:/i, '')
    .replace(/[\s()-]/g, '');
  if (!cleaned) return '';
  const withPlus = /^\d+$/.test(cleaned) ? `+${cleaned}` : cleaned;
  return `whatsapp:${withPlus}`;
}

function isTwilioRequest(req) {
  // Skip validation when auth token / public URL are not configured (local dev)
  if (!config.twilioAuthToken || !config.publicBaseUrl) {
    console.warn('[whatsapp] ⚠ Twilio signature validation SKIPPED (no auth token / public URL)');
    return true;
  }
  const baseUrl = config.publicBaseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/whatsapp$/i, '');
  const url = `${baseUrl}${req.originalUrl || '/whatsapp'}`;
  const signature = req.headers['x-twilio-signature'] || '';
  const valid = twilio.validateRequest(config.twilioAuthToken, signature, url, req.body);
  if (!valid) {
    console.warn(`[whatsapp] Invalid Twilio signature (expected url: ${url})`);
  }
  return valid;
}

// ─── Message splitting for the 1600-char WhatsApp limit ──────────────────────
function splitMessage(text, maxLen = 1500) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      // Prefer sentence boundary
      const lastPeriod = text.lastIndexOf('.', end);
      if (lastPeriod > start + maxLen / 2) end = lastPeriod + 1;
    }
    parts.push(text.slice(start, end).trim());
    start = end;
  }
  return parts;
}

// ─── Send a WhatsApp reply via the Twilio REST API ────────────────────────────
async function sendWhatsApp(to, body) {
  const fromNumber = normalizeWhatsAppAddress(config.twilioWhatsappNumber);
  const toNumber = normalizeWhatsAppAddress(to);

  if (!config.twilioAccountSid || !config.twilioAuthToken || !fromNumber) {
    const missing = [
      !config.twilioAccountSid && 'TWILIO_ACCOUNT_SID',
      !config.twilioAuthToken && 'TWILIO_AUTH_TOKEN',
      !fromNumber && 'TWILIO_WHATSAPP_NUMBER',
    ].filter(Boolean);
    console.error(`[whatsapp] Cannot send reply — missing env vars: ${missing.join(', ')}`);
    return;
  }

  try {
    const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
    for (const part of splitMessage(body)) {
      const msg = await client.messages.create({
        from: fromNumber,
        to: toNumber,
        body: part,
      });
      console.log(`[whatsapp] Reply sent (SID=${msg.sid}, status=${msg.status})`);
    }
  } catch (err) {
    // Never crash on Twilio errors — log code/status for Railway debugging
    console.error(
      `[whatsapp] Failed to send message (code=${err.code || 'n/a'}, status=${err.status || 'n/a'}): ${err.message}`
    );
  }
}

// ─── Static messages ──────────────────────────────────────────────────────────
const MENU_TEXT =
  'Welcome to the *IEA Assistant* 👋\n\n' +
  'Please select your department:\n\n' +
  'Reply *1* for 👤 HR (Leave, Reimbursement, Policies)\n' +
  'Reply *2* for 💻 IT (Password, VPN, Hardware)\n\n' +
  '_Send *menu* at any time to return here._';

const HELP_TEXT =
  'You can now ask me any question about company policies.\n' +
  'Send *menu* to change your department.';

// ─── Webhook endpoint ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // 1. Validate Twilio signature
  if (!isTwilioRequest(req)) {
    console.warn('[whatsapp] Rejected request with invalid Twilio signature');
    return res.status(403).send('Forbidden');
  }

  // 2. Acknowledge immediately with empty TwiML (prevents 15-second timeout)
  res.type('text/xml').status(200).send('<Response></Response>');

  // 3. Extract message fields
  const from = (req.body.From || '').trim();
  const body = (req.body.Body || '').trim();

  if (!from || !body) return; // nothing to process

  console.log(`[whatsapp] Incoming from ...${from.slice(-4)}: "${body.slice(0, 60)}"`);

  // 4. Process asynchronously (fire-and-forget with error handling)
  processWhatsApp(from, body).catch((err) =>
    console.error('[whatsapp] Async processing error:', err.message)
  );
});

// ─── Async message processor ──────────────────────────────────────────────────
async function processWhatsApp(from, body) {
  const text = body.trim();
  const lower = text.toLowerCase();

  // "menu" resets the session
  if (lower === 'menu') {
    await clearDepartment(from);
    await sendWhatsApp(from, MENU_TEXT);
    return;
  }

  // Check if the user has already selected a department
  let department = await getDepartment(from);

  if (!department) {
    // Handle department selection ('1' or 'hr', '2' or 'it')
    if (lower === '1' || lower === 'hr') {
      await setDepartment(from, 'HR');
      await sendWhatsApp(from, `✅ Great! Switched to *HR* mode.\n${HELP_TEXT}`);
    } else if (lower === '2' || lower === 'it') {
      await setDepartment(from, 'IT');
      await sendWhatsApp(from, `✅ Great! Switched to *IT* mode.\n${HELP_TEXT}`);
    } else {
      // Show menu for any other first input
      await sendWhatsApp(from, MENU_TEXT);
    }
    return;
  }

  // Friendly reminder on short greetings once a department is active
  if (/^(hi|hello|hey|help)[\s!?.]*$/i.test(text)) {
    await sendWhatsApp(
      from,
      `You're currently in *${department}* mode. Ask any ${department} policy question, or reply *menu* to switch departments.`
    );
    return;
  }

  // User has a department — run the RAG pipeline
  const result = await runPipeline({
    question: text,
    department,
    channel: 'whatsapp',
    phone: from,
  });

  // Build the reply text
  let reply = result.answer;

  // Append source documents when available (if not already cited in the answer)
  if (result.sources && result.sources.length > 0 && !/sources?:/i.test(reply)) {
    const srcNames = [
      ...new Set(result.sources.map((s) => s.sourceFile || s.source).filter(Boolean)),
    ].join(', ');
    if (srcNames) reply += `\n\n_Source: ${srcNames}_`;
  }

  // Append cache badge
  if (result.cacheHit && result.cacheHit !== 'none') {
    reply += `\n_⚡ Cached response_`;
  }

  await sendWhatsApp(from, reply);
}

export default router;
