/**
 * whatsapp.js – Twilio WhatsApp webhook handler.
 *
 * Design:
 * 1. Validate the Twilio X-Twilio-Signature header to reject spoofed requests.
 * 2. Compute the reply (menu, department switch, or RAG pipeline) and return it
 *    directly via TwiML (<Response><Message>...</Message></Response>) when it
 *    finishes under 11s (avoids trial-account REST API error 21654).
 * 3. If processing exceeds 11s, respond with empty TwiML before Twilio's 15s
 *    webhook timeout and fall back to delivering the reply via the REST API.
 *
 * Flow for a new number:
 *   → Show department menu ("1 for HR, 2 for IT")
 *   → Save choice in session store
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

const WEBHOOK_TIMEOUT_MS = 11000;

// ─── Webhook endpoint ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // 1. Validate Twilio signature
  if (!isTwilioRequest(req)) {
    console.warn('[whatsapp] Rejected request with invalid Twilio signature');
    return res.status(403).send('Forbidden');
  }

  // 2. Extract message fields
  const from = (req.body.From || '').trim();
  const body = (req.body.Body || '').trim();

  if (!from || !body) {
    return res.type('text/xml').status(200).send('<Response></Response>');
  }

  console.log(`[whatsapp] Incoming from ...${from.slice(-4)}: "${body.slice(0, 60)}"`);

  // 3. Reply directly via TwiML when <11s (works on Twilio trial accounts where
  //    outbound REST freeform body calls return 21654: ContentSid Required).
  let responded = false;
  const timer = setTimeout(() => {
    if (responded || res.headersSent) return;
    responded = true;
    console.warn('[whatsapp] Processing >11s — acking webhook and falling back to REST API');
    res.type('text/xml').status(200).send('<Response></Response>');
  }, WEBHOOK_TIMEOUT_MS);

  try {
    const reply = await buildWhatsAppReply(from, body);
    clearTimeout(timer);

    if (!responded && !res.headersSent) {
      responded = true;
      const twiml = new twilio.twiml.MessagingResponse();
      const parts = splitMessage(reply);
      for (const part of parts) {
        twiml.message(part);
      }
      console.log(`[whatsapp] Replied via TwiML (${parts.length} part(s))`);
      return res.type('text/xml').status(200).send(twiml.toString());
    }

    await sendWhatsApp(from, reply);
  } catch (err) {
    clearTimeout(timer);
    console.error('[whatsapp] Processing error:', err.message);
    if (!responded && !res.headersSent) {
      responded = true;
      res.type('text/xml').status(200).send('<Response></Response>');
    }
  }
});

// ─── Message processor ────────────────────────────────────────────────────────
async function buildWhatsAppReply(from, body) {
  const text = body.trim();
  const lower = text.toLowerCase();

  // "menu" resets the session
  if (lower === 'menu') {
    await clearDepartment(from);
    return MENU_TEXT;
  }

  // Check if the user has already selected a department
  const department = await getDepartment(from);

  if (!department) {
    // Handle department selection ('1' or 'hr', '2' or 'it')
    if (lower === '1' || lower === 'hr') {
      await setDepartment(from, 'HR');
      return `✅ Great! Switched to *HR* mode.\n${HELP_TEXT}`;
    }
    if (lower === '2' || lower === 'it') {
      await setDepartment(from, 'IT');
      return `✅ Great! Switched to *IT* mode.\n${HELP_TEXT}`;
    }
    // Show menu for any other first input
    return MENU_TEXT;
  }

  // Friendly reminder on short greetings once a department is active
  if (/^(hi|hello|hey|help)[\s!?.]*$/i.test(text)) {
    return `You're currently in *${department}* mode. Ask any ${department} policy question, or reply *menu* to switch departments.`;
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

  return reply;
}

export default router;
