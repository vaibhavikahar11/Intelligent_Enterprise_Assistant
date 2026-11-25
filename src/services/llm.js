/**
 * llm.js – Thin wrapper around Google Gemini.
 * All LLM and embedding calls go through this file so the provider can be
 * swapped later by changing only this module.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../config.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

/** Exponential backoff helper */
async function withRetry(fn, maxRetries = 5, baseDelayMs = 2000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err.message || '';
      const isRetryable =
        err.status === 429 ||
        err.status === 503 ||
        msg.includes('quota') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('output text or tool calls') ||  // empty candidates / safety block
        msg.includes('model output') ||
        msg.includes('Service Unavailable');
      if (!isRetryable || attempt === maxRetries) throw err;

      let delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      const match = msg.match(/retry in ([0-9.]+)s/i);
      if (match && match[1]) {
        delay = Math.max(delay, (parseFloat(match[1]) + 1) * 1000);
      }
      console.warn(`[llm] Retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export async function generate(prompt, options = {}) {
  const modelName = options.modelName || config.genModel;
  const generationConfig = {
    temperature: options.temperature ?? 0.1,
    maxOutputTokens: options.maxOutputTokens ?? 2048,
  };
  if (options.responseMimeType) {
    generationConfig.responseMimeType = options.responseMimeType;
  }

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig,
  });

  return withRetry(async () => {
    const result = await model.generateContent(prompt);
    let text;
    try { text = result.response.text(); } catch (e) {
      // SDK throws "model output must contain either output text or tool calls"
      // when candidates are empty — treat as transient and retry
      const err = new Error(e.message); err.status = 503; throw err;
    }
    if (!text || !text.trim()) {
      const err = new Error('Empty response from LLM'); err.status = 503; throw err;
    }
    return text;
  });
}

/**
 * Generate embeddings for one or more texts.
 * @param {string|string[]} texts
 * @returns {Promise<number[][]>} array of embedding vectors
 */
export async function embed(texts) {
  const inputs = Array.isArray(texts) ? texts : [texts];
  const model = genAI.getGenerativeModel({ model: config.embedModel });

  const embeddings = [];
  for (const text of inputs) {
    const result = await withRetry(() =>
      model.embedContent(text)
    );
    embeddings.push(result.embedding.values);
  }
  return embeddings;
}

/**
 * Stream a generation response token by token.
 * Calls onToken(chunk) for each text chunk as it arrives.
 * Returns the full concatenated text when complete.
 */
export async function generateStream(prompt, options = {}, onToken) {
  const modelName = options.modelName || config.genModel;
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature:    options.temperature ?? 0.1,
      maxOutputTokens: options.maxOutputTokens ?? 2048,
    },
  });

  return withRetry(async () => {
    const result = await model.generateContentStream(prompt);
    let fullText = '';
    for await (const chunk of result.stream) {
      let token;
      try { token = chunk.text(); } catch (_) { continue; }
      if (token) {
        fullText += token;
        try { onToken(token); } catch (_) {}
      }
    }
    if (!fullText.trim()) throw Object.assign(new Error('Empty stream response'), { status: 503 });
    return fullText;
  });
}

/**
 * Embed a single string and return a flat vector.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedOne(text) {
  const [vec] = await embed([text]);
  return vec;
}
