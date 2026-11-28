/**
 * filter.js – Profanity, abuse, and topic-relevance pre-filter.
 * Blocked messages never reach cache, retrieval, or the LLM.
 *
 * Layers (in order):
 *  1. Length check
 *  2. Profanity (bad-words library)
 *  3. Custom insults / mild abuse not in bad-words
 *  4. Prompt-injection patterns
 *  5. Topic relevance — must look like an HR/IT question
 */
import Filter from 'bad-words';

const profanityFilter = new Filter();

// ── Layer 3: custom insults / abuse words bad-words misses ────────────────────
const INSULT_WORDS = [
  'idiot', 'stupid', 'dumb', 'moron', 'imbecile', 'fool', 'jerk',
  'loser', 'retard', 'retarded', 'crap', 'clueless', 'useless',
  'incompetent', 'pathetic', 'lame', 'trash', 'garbage', 'nonsense',
  'madpeople', 'mad people',
];

// ── Layer 4: prompt-injection patterns ───────────────────────────────────────
const INJECTION_PATTERNS = [
  /\b(hack|exploit|inject|bypass|override|jailbreak)\b/i,
  /ignore previous instructions/i,
  /forget your instructions/i,
  /disregard (all|your|previous)/i,
  /\bact as\b/i,
  /pretend you are/i,
  /you are now/i,
  /system prompt/i,
  /DAN mode/i,
];

// ── Layer 5: topic-relevance ──────────────────────────────────────────────────
// Domain keywords anchor the question to HR/IT. If none are present, the
// question must contain a question-word AND must NOT be clearly off-topic.
const DOMAIN_KEYWORDS = [
  /\b(hr|it|leaves?|vacations?|holidays?|polic(?:y|ies)|benefits?|perks?|salar(?:y|ies)|payroll|bonus(?:es)?|stipend|overtime|probation|working hours?|work[- ]?from[- ]?home|wfh|employees?|onboard(?:ing|ed)?|offboard(?:ing|ed)?|reimburs(?:e|ement|ements)?|expenses?|performance|appraisals?|promotions?|resign(?:ation|ing)?|terminat(?:e|ed|ing|ion)?|hir(?:e|ing)|recruit(?:ing|ment)?|training|transfer|parental|maternity|paternity|sick|pto|severance|fmla|401k|insurance|moonlighting|handbook|code of conduct|code-of-conduct)\b/i,
  /\b(vpn|passwords?|wifi|wi-fi|laptops?|hardware|software|helpdesk|help desk|tickets?|access|accounts?|emails?|devices?|setup|install(?:ation)?|reset|2fa|mfa|two[- ]?(?:factor|step)|verification|sso|authenticat(?:e|ion)|remote|networks?|printers?|monitors?|keyboards?|headsets?|incidents?|sla)\b/i,
];

const QUESTION_WORDS = [
  /\b(how|when|where|why|who|which|can|could|should|would|tell|explain|help|need|want|request|apply|check|find|show|list|provide|guide|steps?|procedure|process)\b/i,
];

// Explicit off-topic topics — blocked even if they have a question word
const OFF_TOPIC_PATTERNS = [
  /\b(weather|cricket|football|sport|movie|film|recipe|cook|stock|bitcoin|crypto|news|politics|president|prime minister|celebrity|game|gaming|music|song|dance|dating)\b/i,
];

const MAX_INPUT_LENGTH = 1000;
const MIN_INPUT_LENGTH = 3;

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
  const lower   = trimmed.toLowerCase();
  const isShortGreeting = trimmed.length <= 20 &&
    /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|bye|good|help)[\s!?.]*$/i.test(trimmed);

  // ── 1. Length ──────────────────────────────────────────────────────────────
  if (trimmed.length < MIN_INPUT_LENGTH && !isShortGreeting) {
    return { blocked: true, reason: 'Input is too short. Please ask a complete question.' };
  }
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return {
      blocked: true,
      reason: `Input is too long. Please keep questions under ${MAX_INPUT_LENGTH} characters.`,
    };
  }

  // ── 2. bad-words library ───────────────────────────────────────────────────
  try {
    if (profanityFilter.isProfane(trimmed)) {
      return { blocked: true, reason: '🚫 Your message contains inappropriate language. Please keep it professional.' };
    }
  } catch {
    // bad-words can throw on edge cases — ignore
  }

  // ── 3. Custom insults / mild abuse ────────────────────────────────────────
  for (const word of INSULT_WORDS) {
    // Match whole word (or phrase)
    const pattern = new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (pattern.test(lower)) {
      return {
        blocked: true,
        reason: '🚫 Your message contains inappropriate or disrespectful language. Please rephrase professionally.',
      };
    }
  }

  // ── 4. Prompt injection ────────────────────────────────────────────────────
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        blocked: true,
        reason: '🚫 Your message was flagged as a potential prompt injection attempt.',
      };
    }
  }

  // ── 5. Topic relevance ────────────────────────────────────────────────────
  // Allow short greetings (hi, hello, thanks) through without domain check
  if (!isShortGreeting) {
    // Block explicit off-topic subjects even if they have a question word
    const isOffTopic = OFF_TOPIC_PATTERNS.some(p => p.test(trimmed));
    if (isOffTopic) {
      return {
        blocked: true,
        reason: '🚫 I can only answer questions about HR policies and IT support. Please ask a relevant question (e.g. "How do I apply for leave?" or "How do I reset my password?").',
      };
    }

    const hasQuestionWord = QUESTION_WORDS.some(p => p.test(trimmed));
    const hasDomainWord   = DOMAIN_KEYWORDS.some(p => p.test(trimmed));

    if (!hasQuestionWord && !hasDomainWord) {
      return {
        blocked: true,
        reason: '🚫 I can only answer questions about HR policies and IT support. Please ask a relevant question (e.g. "How do I apply for leave?" or "How do I reset my password?").',
      };
    }
  }

  return { blocked: false };
}
