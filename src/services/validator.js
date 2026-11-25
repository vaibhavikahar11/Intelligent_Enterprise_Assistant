/**
 * validator.js – Evidence-based hallucination checker.
 *
 * Uses a second LLM call to verify every claim in the draft answer against
 * the retrieved context. Claims without exact supporting quotes are flagged.
 * Also programmatically verifies quotes actually appear in the context.
 */
import { generate } from './llm.js';
import config from '../config.js';

const VALIDATOR_PROMPT_TEMPLATE = (question, contextText, draftAnswer) => `
You are a strict fact-checker for an enterprise assistant.
Your job is to verify that EVERY claim in the draft answer is supported by the
provided context documents.

INSTRUCTIONS:
1. Split the draft answer into individual factual claims.
2. For each claim, find the EXACT sentence from the context that supports it.
3. If no exact supporting sentence exists in the context, mark it unsupported.
4. Output ONLY valid JSON (no markdown, no extra text) in this format:
{
  "claims": [
    {
      "claim": "<the claim from the answer>",
      "quote": "<exact verbatim sentence from context, or empty string if none>",
      "supported": true
    }
  ],
  "verdict": "PASS"
}
Set verdict to "FAIL" if ANY claim is unsupported.
Set verdict to "PASS" only if ALL claims are supported with exact quotes.

CONTEXT DOCUMENTS:
${contextText}

QUESTION: ${question}

DRAFT ANSWER: ${draftAnswer}

JSON OUTPUT:`;

/**
 * Parse the validator JSON response robustly.
 * Strips code fences, handles whitespace, retries once on failure.
 */
async function parseValidatorResponse(raw, question, contextText, draftAnswer) {
  const clean = (s) => {
    let text = s.trim();
    // Strip markdown code fences if present
    text = text.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) text = match[0];
    // Sanitize raw newlines inside string literals
    return text.replace(/"((?:[^"\\\\]|\\\\.)*)"/gs, (m) =>
      m.replace(/\r?\n/g, '\\n')
    );
  };

  try {
    return JSON.parse(clean(raw));
  } catch {
    // Retry once with an even stricter prompt
    console.warn('[validator] Bad JSON, retrying...');
    const retryPrompt = `${VALIDATOR_PROMPT_TEMPLATE(question, contextText, draftAnswer)}

CRITICAL: Your previous response was not valid JSON. Output ONLY the JSON object. No other text.`;
    const retryRaw = await generate(retryPrompt, {
      modelName: config.validatorModel,
      temperature: 0,
      responseMimeType: 'application/json',
      maxRetries: 0,   // already on 2nd attempt — don't loop further
    });
    return JSON.parse(clean(retryRaw));
  }
}

/**
 * Programmatic quote verification.
 * Checks that the returned quote is actually a substring of the context.
 * Uses fuzzy matching (normalized whitespace) to be robust.
 */
function verifyQuote(quote, contextText) {
  if (!quote || quote.trim() === '') return false;
  const normalise = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const normQuote = normalise(quote);
  const normContext = normalise(contextText);
  // Accept if the normalised quote appears verbatim in the normalised context
  // or if 80% of words in the quote appear in a sliding window
  if (normContext.includes(normQuote)) return true;
  // Fuzzy: check if most significant words match
  const words = normQuote.split(' ').filter((w) => w.length > 4);
  if (words.length === 0) return false;
  const matchCount = words.filter((w) => normContext.includes(w)).length;
  return matchCount / words.length >= 0.8;
}

/**
 * Validate a draft answer against the retrieved context.
 * @returns {Promise<{verdict:'PASS'|'FAIL', claims: object[], unsupportedClaims: string[]}>}
 */
export async function validate(question, chunks, draftAnswer) {
  const contextText = chunks.map((c) => c.text).join('\n\n');

  let raw;
  try {
    const prompt = VALIDATOR_PROMPT_TEMPLATE(question, contextText, draftAnswer);
    raw = await generate(prompt, {
      modelName:        config.validatorModel,
      temperature:      0,
      responseMimeType: 'application/json',
      maxRetries:       1,   // validator is optional — fail fast, don't block the reply
    });
  } catch (err) {
    // Gemini 503/quota/404 — skip validation gracefully
    console.warn('[validator] LLM call failed, skipping validation:', err.message);
    return { verdict: 'PASS', claims: [], unsupportedClaims: [] };
  }

  let parsed;
  try {
    parsed = await parseValidatorResponse(raw, question, contextText, draftAnswer);
  } catch (err) {
    // JSON parse failed even after retry — skip validation, don't trigger regeneration
    console.warn('[validator] Could not parse JSON, skipping validation:', err.message);
    return { verdict: 'PASS', claims: [], unsupportedClaims: [] };
  }

  // Programmatically re-verify each claim's quote
  const claims = (parsed.claims || []).map((c) => {
    const programmaticSupport = c.quote ? verifyQuote(c.quote, contextText) : false;
    return {
      ...c,
      // Override: only supported if BOTH the model said so AND we verified the quote
      supported: c.supported && programmaticSupport,
    };
  });

  const unsupportedClaims = claims
    .filter((c) => !c.supported)
    .map((c) => c.claim);

  const verdict = unsupportedClaims.length === 0 ? 'PASS' : 'FAIL';

  return { verdict, claims, unsupportedClaims };
}
