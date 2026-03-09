import { generate } from '../../llm.js';

// Dynamic import: Playwright may not be available in serverless environments
async function getPlaywrightSearch() {
  try {
    const mod = await import('../../tools/playwright-search.js');
    return mod.playwrightSearch;
  } catch {
    return null;
  }
}

export async function runResearchAgent(messages, model, onScreenshot) {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  const playwrightSearch = await getPlaywrightSearch();

  // Fallback: no Playwright available (serverless) — use LLM knowledge directly
  if (!playwrightSearch) {
    console.log('[research] Playwright not available, using LLM knowledge');
    return generate(model, messages, {
      system: `You are a research specialist AI agent. Answer the user's question using your training knowledge.
Be thorough, accurate, and provide specific details. If you're unsure, say so.
Respond in the same language as the user.`,
      temperature: 0.5,
      maxTokens: 2048,
    });
  }

  // Generate search query
  const searchQuery = await generate(model, [
    { role: 'user', content: `Convert this question into a Google search query. The query should be specific enough to find the answer. Output ONLY the search query text, no quotes, no explanation.\n\nQuestion: ${lastUserMsg}` },
  ], {
    temperature: 0.3,
    maxTokens: 100,
  });

  const rawQuery = searchQuery.trim().replace(/^["']|["']$/g, '');
  const finalQuery = rawQuery.length >= 5 ? rawQuery : lastUserMsg;
  console.log(`[research] Search query: "${finalQuery}" (generated: "${rawQuery}")`);

  // Perform web search with Playwright
  const searchResult = await playwrightSearch(finalQuery, onScreenshot);

  // Analyze search results
  const context = [
    `Search query: "${searchResult.query}"`,
    `Source: ${searchResult.source}`,
    '',
    'Search results:',
    ...searchResult.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`),
  ];

  if (searchResult.pageContent) {
    context.push('', 'Page content (from first result):', searchResult.pageContent);
  }

  const analysisMessages = [
    ...messages,
    { role: 'assistant', content: `I searched the web and found the following:\n\n${context.join('\n')}` },
    { role: 'user', content: 'Based on the search results above, provide a comprehensive answer to my original question. Cite sources when possible.' },
  ];

  const analysis = await generate(model, analysisMessages, {
    system: `You are a research specialist. Analyze the web search results and provide a thorough, well-sourced answer. Include relevant URLs as references. Respond in the same language as the user.`,
    temperature: 0.5,
    maxTokens: 2048,
  });

  return analysis;
}
