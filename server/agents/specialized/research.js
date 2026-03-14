import { generate } from '../../llm.js';
import { webSearch } from '../../tools/web-search.js';

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

  // Generate search query
  const searchQuery = await generate(model, [
    { role: 'user', content: `Convert this question into a web search query. Output ONLY the search query text, no quotes, no explanation.\n\nQuestion: ${lastUserMsg}` },
  ], {
    temperature: 0.3,
    maxTokens: 100,
  });

  const rawQuery = searchQuery.trim().replace(/^["']|["']$/g, '');
  const finalQuery = rawQuery.length >= 5 ? rawQuery : lastUserMsg;
  console.log(`[research] Search query: "${finalQuery}"`);

  // Primary: fetch-based DuckDuckGo search (no browser, no CAPTCHA)
  let searchResult;
  try {
    onScreenshot?.({ image: '', label: `🔍 "${finalQuery}" 검색 중... (DuckDuckGo)` });
    searchResult = await webSearch(finalQuery, { maxResults: 5, fetchContent: true });
    console.log(`[research] DDG results: ${searchResult.results.length} items`);

    if (searchResult.results.length > 0) {
      onScreenshot?.({ image: '', label: `✅ 검색 완료 (${searchResult.results.length}건)` });
    }
  } catch (err) {
    console.error('[research] DDG search failed:', err.message);
    searchResult = null;
  }

  // Fallback: Playwright if DDG returned no results
  if (!searchResult || searchResult.results.length === 0) {
    const playwrightSearch = await getPlaywrightSearch();
    if (playwrightSearch) {
      try {
        onScreenshot?.({ image: '', label: '🔄 브라우저 검색으로 전환...' });
        searchResult = await playwrightSearch(finalQuery, onScreenshot);
        console.log(`[research] Playwright results: ${searchResult.results.length} items`);
      } catch (err) {
        console.error('[research] Playwright search failed:', err.message);
      }
    }
  }

  // Final fallback: LLM knowledge only
  if (!searchResult || searchResult.results.length === 0) {
    console.log('[research] No search results, using LLM knowledge');
    return generate(model, messages, {
      system: `You are a research specialist AI agent. Answer the user's question using your training knowledge.
Be thorough, accurate, and provide specific details. If you're unsure, say so.
Respond in the same language as the user.`,
      temperature: 0.5,
      maxTokens: 2048,
    });
  }

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
    system: `You are a research specialist. Analyze the web search results and provide a thorough, well-informed answer. Do NOT include any URLs, links, or source/reference sections — source citations are handled separately by the system. Respond in the same language as the user.`,
    temperature: 0.5,
    maxTokens: 2048,
  });

  return analysis;
}
