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
- "general": ONLY for simple greetings (안녕, hi) or trivial meta-questions (넌 뭐야?)
- "research": Questions needing web search — current events, facts, news, "~에 대해 알려줘", comparisons
- "browser": Requests involving a SPECIFIC WEBSITE — "쿠팡에서 검색", "사이트 접속해서 테스트", "로그인해서 확인", product search on specific sites, price comparison on shopping sites, scraping a specific URL
- "coding": Code writing, debugging, algorithms, architecture, programming questions
- "math": Math problems, calculations, statistics, numerical analysis
- "creative": Creative writing, brainstorming, storytelling, poetry, marketing copy
- "interactive": Requests to CREATE something visual, interactive, or runnable — "만들어줘", "보여줘", "그려줘", "시각화", games, charts, graphs, infographics, dashboards, timelines, diagrams, animations, calculators, visualizations, simulations, interactive demos, SVG, HTML/CSS/JS demos, web components, UI prototypes

Respond with JSON:
{
  "category": "general" | "research" | "browser" | "coding" | "math" | "creative" | "interactive",
  "complexity": "simple" | "complex",
  "suggestedAgents": ["agent1"],
  "reasoning": "brief explanation"
}

CRITICAL routing rules (follow strictly):
- If the user asks to CREATE/BUILD/MAKE something visual or interactive (게임, 차트, 애니메이션, 계산기, 시뮬레이션, 시각화, 타이머, 퀴즈, 그래프, 인포그래픽, 대시보드, 타임라인, 다이어그램, SVG 등) → "interactive"
- If the user wants to SEE or PREVIEW something rendered in the chat → "interactive"
- If the user asks to DRAW, VISUALIZE, or DIAGRAM something → "interactive"
- If the user mentions a specific website/service name (쿠팡, 네이버, 11번가, Amazon, etc.) and wants to search/browse/interact with it → "browser"
- If the user wants to log in, test a site, click menus, scrape product lists → "browser"
- If the user asks a factual question without mentioning a specific site → "research"
- If the user asks about code concepts, debugging, algorithms (NOT creating visual output) → "coding"
- "general" is ONLY for greetings and very simple chat. Any real question should go to a specialized agent.
- Shopping/product/price queries mentioning a specific store → "browser"
- Shopping/product queries WITHOUT a specific store → "research"
- When "interactive" is selected, use ONLY "interactive" — it handles both text and visuals. So: "suggestedAgents": ["interactive"]
- Other agents: use 1 agent normally. Use 2 only for genuinely multi-faceted requests.`,
      temperature: 0.2,
      maxTokens: 600,
    });

    const validAgents = new Set(['general', 'research', 'browser', 'coding', 'math', 'creative', 'interactive']);
    let suggestedAgents = (result.suggestedAgents || [result.category || 'general'])
      .filter((a) => validAgents.has(a));

    // Interactive runs alone — it provides its own text intro/outro
    if (suggestedAgents.includes('interactive')) {
      suggestedAgents = ['interactive'];
    }

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
