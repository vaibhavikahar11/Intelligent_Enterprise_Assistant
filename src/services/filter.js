/**
 * filter.js – Profanity and abuse pre-filter.
 * Blocked messages never reach cache, retrieval, or the LLM.
 */
import Filter from 'bad-words';

const profanityFilter = new Filter();

// Custom blocked patterns beyond bad-words library
const CUSTOM_BLOCKED = [
  /\b(hack|exploit|inject|bypass|override|jailbreak)\b/i,
  /ignore previous instructions/i,
  /forget your instructions/i,
  /act as/i,
  /pretend you are/i,
];

const MAX_INPUT_LENGTH = 1000;
const MIN_INPUT_LENGTH = 2;

/**
 * Check if the input should be blocked.
 * @param {string} text
 * @returns {{ blocked: boolean, reason?: string }}
 */
export function checkInput(text) {
  if (typeof text !== 'string') {
    return { blocked: true, reason: 'Invalid input type.' };
  }

  const trimmed = text.trim();

  if (trimmed.length < MIN_INPUT_LENGTH) {
    return { blocked: true, reason: 'Input is too short. Please ask a complete question.' };
  }

  if (trimmed.length > MAX_INPUT_LENGTH) {
    return {
      blocked: true,
      reason: `Input is too long. Please keep questions under ${MAX_INPUT_LENGTH} characters.`,
    };
  }

  try {
    if (profanityFilter.isProfane(trimmed)) {
      return { blocked: true, reason: 'Your message contains inappropriate language.' };
    }
  } catch {
    // bad-words can throw on edge cases – ignore
  }

  for (const pattern of CUSTOM_BLOCKED) {
    if (pattern.test(trimmed)) {
      return {
        blocked: true,
        reason: 'Your message was flagged as a potential prompt injection attempt.',
      };
    }
  }

  return { blocked: false };
}
