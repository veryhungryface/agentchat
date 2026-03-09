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

IMPORTANT rules:
- Default to safe=true. Almost all questions should be safe.
- Only flag as unsafe if the message explicitly requests: creating malware/viruses, generating CSAM, detailed instructions for weapons/explosives/drugs, or targeted harassment of real individuals.
- Coding questions, login/auth testing, security research, penetration testing, hacking tutorials, web scraping, data extraction — ALL are safe.
- Questions about controversial topics, politics, adult themes — safe.
- When in doubt, mark as safe.`,
      temperature: 0.1,
      maxTokens: 400,
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
