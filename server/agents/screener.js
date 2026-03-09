import { generateJSON } from '../llm.js';

/**
 * Screen a user query for safety.
 * @returns {{ safe: boolean, category: string, reason: string }}
 */
export async function screenQuery(query, model) {
  try {
    const result = await generateJSON(model, [{ role: 'user', content: query }], {
      system: `You are a content safety classifier. Analyze the user message and respond with JSON:
{
  "safe": true/false,
  "category": "safe" | "inappropriate" | "harmful" | "spam",
  "reason": "brief explanation"
}
Be lenient with normal questions. Only flag truly harmful content.`,
      temperature: 0.1,
      maxTokens: 200,
    });

    return {
      safe: result.safe !== false,
      category: result.category || 'safe',
      reason: result.reason || '',
    };
  } catch (err) {
    console.error('[screener] Error:', err.message);
    // Default to safe on error to avoid blocking legitimate requests
    return { safe: true, category: 'safe', reason: 'Screening skipped due to error' };
  }
}
