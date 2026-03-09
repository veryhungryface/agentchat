import { generateJSON } from '../llm.js';

/**
 * Classify a query and determine which agents to dispatch.
 * @returns {{ category, complexity, requiresMultipleAgents, suggestedAgents, reasoning }}
 */
export async function classifyQuery(query, model) {
  try {
    const result = await generateJSON(model, [{ role: 'user', content: query }], {
      system: `You are a query classifier for an AI orchestration system.
Analyze the user message and determine which specialized agent(s) should handle it.

Available agents:
- "general": Simple greetings, casual conversation, basic knowledge questions
- "research": Questions requiring current/factual info, news, comparisons, anything needing web search
- "coding": Code writing, debugging, code review, algorithms, architecture
- "math": Math problems, statistics, numerical analysis, calculations
- "creative": Creative writing, brainstorming, storytelling, marketing copy

Respond with JSON:
{
  "category": "general" | "research" | "coding" | "math" | "creative",
  "complexity": "simple" | "complex",
  "requiresMultipleAgents": false,
  "suggestedAgents": ["agent1", "agent2"],
  "reasoning": "brief explanation"
}

Rules:
- For simple greetings or trivial questions, use ["general"] only.
- If the question requires up-to-date information or facts you're not sure about, include "research".
- Complex questions may need multiple agents (e.g. "research + math" for data analysis with current data).
- Most questions need only 1 agent. Use 2+ only for genuinely multi-faceted requests.`,
      temperature: 0.2,
      maxTokens: 300,
    });

    const validAgents = new Set(['general', 'research', 'coding', 'math', 'creative']);
    const suggestedAgents = (result.suggestedAgents || [result.category || 'general'])
      .filter((a) => validAgents.has(a));

    return {
      category: result.category || 'general',
      complexity: result.complexity || 'simple',
      requiresMultipleAgents: suggestedAgents.length > 1,
      suggestedAgents: suggestedAgents.length > 0 ? suggestedAgents : ['general'],
      reasoning: result.reasoning || '',
    };
  } catch (err) {
    console.error('[router] Error:', err.message);
    return {
      category: 'general',
      complexity: 'simple',
      requiresMultipleAgents: false,
      suggestedAgents: ['general'],
      reasoning: 'Routing fallback due to error',
    };
  }
}
