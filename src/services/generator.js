/**
 * generator.js – Builds the RAG prompt and generates the answer.
 * Strict grounding: answer ONLY from provided context.
 * Citations include source organisation and file name.
 * Supports optional token-streaming via onToken callback.
 */
import { generate, generateStream } from './llm.js';

const SYSTEM_PROMPT = `You are a knowledgeable enterprise assistant for employees.
You answer HR and IT questions ONLY using the provided context documents.

Rules you MUST follow:
1. Answer ONLY from the context below. Do not use any outside knowledge.
2. If the context does not contain the answer, say: "I could not find this information in the company documents. Please contact HR/IT directly."
3. Never guess, invent, or extrapolate numbers, dates, percentages, or policies.
4. Keep answers concise and factual.
5. At the end of EVERY answer, include a "Sources:" line listing each document cited, in the format:
   Sources: [Organisation – filename]
   Example: Sources: [GitLab – GitLab_handbook_paid_time_off.pdf], [37signals – making-a-career.md]
6. Do not make up carry-forward rules, approval workflows, or any policy not explicitly stated.
7. If context is ambiguous, say so and recommend contacting HR/IT.`;

/**
 * Build a human-readable label for a chunk citation.
 * Prefers sourceOrg + sourceFile; falls back to source.
 */
function citationLabel(metadata) {
  const org  = metadata?.sourceOrg  || '';
  const file = metadata?.sourceFile || metadata?.source || 'unknown';
  return org ? `${org} – ${file}` : file;
}

/**
 * Generate a RAG answer.
 * @param {string}   question
 * @param {object[]} chunks     Retrieved context chunks [{text, metadata}]
 * @param {object}   [options]  { unsupportedClaims } – on regeneration
 * @param {Function} [onToken]  called with each streamed token (string)
 * @returns {Promise<string>}
 */
export async function generateAnswer(question, chunks, options = {}, onToken = null) {
  // Build context block — include org, file, section in each context header
  const contextBlock = chunks
    .map((c, i) => {
      const label   = citationLabel(c.metadata);
      const section = c.metadata?.section || '';
      const url     = c.metadata?.sourceUrl || '';
      const header  = [
        `[Context ${i + 1}]`,
        `Source: ${label}`,
        section ? `Section: ${section}` : '',
        url     ? `URL: ${url}`         : '',
      ].filter(Boolean).join(' | ');
      return `${header}\n${c.text}`;
    })
    .join('\n\n');

  let unsupportedNote = '';
  if (options.unsupportedClaims?.length > 0) {
    unsupportedNote =
      `\n\nIMPORTANT: A previous answer contained unsupported claims. Do NOT state:\n` +
      options.unsupportedClaims.map((c) => `- ${c}`).join('\n') +
      `\nOnly state facts explicitly present in the context.`;
  }

  const prompt = `${SYSTEM_PROMPT}

${'='.repeat(60)}
CONTEXT DOCUMENTS:
${contextBlock}
${'='.repeat(60)}
${unsupportedNote}

Employee Question: ${question}

Answer:`;

  return (typeof onToken === 'function')
    ? generateStream(prompt, { temperature: 0.1 }, onToken)
    : generate(prompt, { temperature: 0.1 });
}

/**
 * Build a sources array for the API response payload.
 * Each entry: { id, source, sourceOrg, sourceFile, sourceUrl, score }
 */
export function buildSourcesPayload(chunks) {
  return chunks.map((c) => ({
    id:         c.id,
    source:     c.metadata?.source     || '',
    sourceOrg:  c.metadata?.sourceOrg  || '',
    sourceFile: c.metadata?.sourceFile || c.metadata?.source || '',
    sourceUrl:  c.metadata?.sourceUrl  || '',
    score:      c.score,
  }));
}
