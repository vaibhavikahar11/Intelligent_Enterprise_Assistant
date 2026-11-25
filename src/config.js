/**
 * config.js – loads and validates environment variables.
 * Throws on startup if any required variable is missing.
 */
import 'dotenv/config';

const required = [
  'GEMINI_API_KEY',
  'GEN_MODEL',
  'VALIDATOR_MODEL',
  'EMBED_MODEL',
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[config] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[config] Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

const config = Object.freeze({
  // LLM
  geminiApiKey: process.env.GEMINI_API_KEY,
  genModel: process.env.GEN_MODEL,
  validatorModel: process.env.VALIDATOR_MODEL,
  embedModel: process.env.EMBED_MODEL,

  // Twilio
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioWhatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER || '',

  // Infrastructure
  redisUrl: process.env.REDIS_URL || '',
  chromaUrl: process.env.CHROMA_URL || '',
  port: parseInt(process.env.PORT || '3000', 10),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',

  // Cache
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '86400', 10),
  cacheSimThreshold: parseFloat(process.env.CACHE_SIM_THRESHOLD || '0.92'),

  // Retrieval
  retrievalTopK: parseInt(process.env.RETRIEVAL_TOP_K || '4', 10),
  retrievalMinScore: parseFloat(process.env.RETRIEVAL_MIN_SCORE || '0.5'),

  // Pipeline
  validateRequests: process.env.VALIDATE_REQUESTS !== 'false',
});

export default config;
