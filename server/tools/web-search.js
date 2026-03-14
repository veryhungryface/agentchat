/**
 * Lightweight web search using DuckDuckGo HTML endpoint.
 * No browser (Playwright) needed, no API key needed.
 * Works in serverless environments (Vercel).
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOCKED_DOMAINS = /coupang\.com|naver\.com|daum\.net|tistory\.com|instagram\.com|facebook\.com|twitter\.com|x\.com/i;

/**
 * Search the web and optionally fetch page content from the top result.
 * @param {string} query - Search query
 * @param {object} opts - { maxResults, fetchContent }
 * @returns {Promise<{ query, results, pageContent, source }>}
 */
export async function webSearch(query, { maxResults = 5, fetchContent = true } = {}) {
  const results = await searchDDG(query, maxResults);

  let pageContent = '';
  let source = 'duckduckgo.com';

  if (fetchContent && results.length > 0) {
    for (const r of results.slice(0, 3)) {
      if (!r.url || BLOCKED_DOMAINS.test(r.url)) continue;
      try {
        const content = await fetchPageContent(r.url);
        if (content && content.length > 100) {
          pageContent = content;
          source = r.url;
          break;
        }
      } catch { /* try next */ }
    }
  }

  return { query, results, pageContent, source };
}

// ── DuckDuckGo HTML search ──────────────────────────────────────────────────

async function searchDDG(query, maxResults) {
  const resp = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    },
    body: `q=${encodeURIComponent(query)}&kl=kr-kr`,
    redirect: 'follow',
  });

  if (!resp.ok) {
    console.error(`[web-search] DDG returned ${resp.status}`);
    return [];
  }

  const html = await resp.text();
  return parseDDGResults(html, maxResults);
}

function parseDDGResults(html, max) {
  const results = [];
  // Split by result blocks
  const blocks = html.split(/class="result\s+results_links/);

  for (let i = 1; i < blocks.length && results.length < max; i++) {
    const block = blocks[i];

    // Extract URL from result__a href
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]*)"/);
    if (!urlMatch) continue;

    let url = urlMatch[1];
    // Decode DDG redirect: //duckduckgo.com/l/?uddg=ENCODED_URL
    const uddgMatch = url.match(/uddg=([^&]*)/);
    if (uddgMatch) {
      try { url = decodeURIComponent(uddgMatch[1]); } catch { /* keep raw */ }
    }
    // Ensure absolute URL
    if (url.startsWith('//')) url = 'https:' + url;

    // Extract title (strip HTML tags)
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    if (url && title) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

// ── Page content fetcher ────────────────────────────────────────────────────

async function fetchPageContent(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!resp.ok) return '';

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) return '';

    const html = await resp.text();

    // Strip scripts, styles, nav, header, footer → extract text
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned.slice(0, 3000);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
