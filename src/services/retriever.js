/**
 * retriever.js – Embeds a query and retrieves relevant chunks from Chroma.
 * Drops results below the configured minimum similarity score.
 */
import { embedOne } from './llm.js';
import { queryChunks } from './vectorStore.js';
import config from '../config.js';

/**
 * Retrieve top-k relevant chunks for a question.
 * @param {string} question
 * @param {string} department  'HR' | 'IT'
 * @returns {Promise<Array<{id, text, metadata, score}>>}  Filtered chunks
 */
export async function retrieve(question, department) {
  // 1. Embed the query
  const queryEmbedding = await embedOne(question);

  // 2. Query ChromaDB
  const results = await queryChunks(
    queryEmbedding,
    department,
    config.retrievalTopK
  );

  // 3. Filter by minimum similarity score
  const filtered = results.filter((r) => r.score >= config.retrievalMinScore);

  return filtered;
}
