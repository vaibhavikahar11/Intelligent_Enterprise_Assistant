/**
 * whatsapp.js – WhatsApp webhook handler (Meta Cloud API + Twilio fallback).
 *
 * Meta Cloud API flow:
 * - GET  /whatsapp : Hub challenge verification using META_VERIFY_TOKEN
 * - POST /whatsapp : Handles JSON payloads (`object === 'whatsapp_business_account'`),
 *                    responds 200 immediately, runs shared pipeline, and sends
 *                    custom text replies via Graph API (`/{phoneNumberId}/messages`).
 *
 * Twilio flow (legacy / fallback):
 * - POST /whatsapp : Validates X-Twilio-Signature, replies via TwiML (<11s) or REST.
 *
 * Shared conversation flow:
 *   → Show department menu ("1 for HR, 2 for IT")
 *   → Save choice in session store
 *   → Subsequent messages go straight to the RAG pipeline
 *   → Sending "menu" resets the session
 */
import crypto from 'crypto';
import { Router } from 'express';
import twilio from 'twilio';
import config from '../config.js';
import { runPipeline } from '../pipeline.js';
import { getDepartment, setDepartment, clearDepartment } from '../services/session.js';

const router = Router();

// Deduplicate Meta webhook retries by message ID (bounded FIFO set)
const _seenMessageIds = new Set();
const MAX_SEEN_IDS = 500;

function markMessageSeen(id) {
  if (!id) return false;
  if (_seenMessageIds.has(id)) return true;
  _seenMessageIds.add(id);
  if (_seenMessageIds.size > MAX_SEEN_IDS) {
    const oldest = _seenMessageIds.values().next().value;
    _seenMessageIds.delete(oldest);
  }
  return false;
}

// ─── Meta Cloud API signature & send helpers ──────────────────────────────────
function isMetaSignatureValid(req) {
  if (!config.metaAppSecret) return true; // optional unless META_APP_SECRET is set
  const header = req.headers['x-hub-signature-256'] || '';
  if (!header.startsWith('sha256=') || !req.rawBody) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', config.metaAppSecret).update(req.rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function sendMetaWhatsApp(phoneNumberId, to, body) {
  const pid = config.metaPhoneNumberId || phoneNumberId;
  if (!config.metaAccessToken || !pid) {
    const missing = [
      !config.metaAccessToken && 'META_WHATSAPP_TOKEN',
      !pid && 'META_PHONE_NUMBER_ID',
    ].filter(Boolean);
    console.error(`[whatsapp-meta] Cannot send reply — missing env vars: ${missing.join(', ')}`);
    return;
  }

  const endpoint = `https://graph.facebook.com/${config.metaGraphVersion}/${pid}/messages`;
  for (const part of splitMessage(body, 3500)) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.metaAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: part },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error(
          `[whatsapp-meta] Failed to send (status=${res.status}, code=${data?.error?.code || 'n/a'}): ${data?.error?.message || res.statusText}`
        );
      } else {
        console.log(`[whatsapp-meta] Reply sent (id=${data?.messages?.[0]?.id || 'ok'})`);
      }
    } catch (err) {
      console.error('[whatsapp-meta] Network error sending message:', err.message);
    }
  }
}

async function handleMetaWebhook(req, res) {
  if (!isMetaSignatureValid(req)) {
    console.warn('[whatsapp-meta] Rejected request with invalid X-Hub-Signature-256');
    return res.sendStatus(403);
  }

  // Acknowledge immediately so Meta does not retry the webhook
  res.status(200).send('EVENT_RECEIVED');

  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== 'messages') continue;
      const value = change.value || {};
      const phoneNumberId = value?.metadata?.phone_number_id || '';
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const waId = value?.contacts?.[0]?.wa_id || '';

      for (const msg of messages) {
        if (markMessageSeen(msg.id)) continue;

        const from = (waId || msg.from || '').trim();
        if (!from) continue;

        if (msg.type !== 'text') {
          console.log(`[whatsapp-meta] Non-text (${msg.type}) from ...${from.slice(-4)}`);
          await sendMetaWhatsApp(
            phoneNumberId,
            from,
            'Sorry, I can only read text messages right now. Please type your HR or IT question.'
          );
          continue;
        }

        const body = (msg.text?.body || '').trim();
        if (!body) continue;

        console.log(`[whatsapp-meta] Incoming from ...${from.slice(-4)}: "${body.slice(0, 60)}"`);
        try {
          const reply = await buildWhatsAppReply(from, body);
          await sendMetaWhatsApp(phoneNumberId, from, reply);
        } catch (err) {
          console.error('[whatsapp-meta] Processing error:', err.message);
          await sendMetaWhatsApp(
            phoneNumberId,
            from,
            'Sorry, something went wrong while processing your question. Please try again.'
          );
        }
      }
    }
  }
}

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

// ─── Meta webhook verification (GET /whatsapp) ────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (!mode || !token) {
    return res.sendStatus(400);
  }
  if (!config.metaVerifyToken) {
    console.warn('[whatsapp-meta] Verification failed — META_VERIFY_TOKEN is not set');
    return res.sendStatus(403);
  }

  const a = Buffer.from(String(token));
  const b = Buffer.from(config.metaVerifyToken);
  if (mode === 'subscribe' && a.length === b.length && crypto.timingSafeEqual(a, b)) {
    console.log('[whatsapp-meta] Webhook verified');
    return res.status(200).send(String(challenge || ''));
  }

  console.warn('[whatsapp-meta] Webhook verification rejected (token mismatch)');
  return res.sendStatus(403);
});

// ─── Webhook endpoint (POST /whatsapp: Meta JSON or Twilio form-urlencoded) ──
router.post('/', async (req, res) => {
  if (req.body?.object === 'whatsapp_business_account') {
    return handleMetaWebhook(req, res);
  }

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
