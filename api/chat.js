/**
 * Vercel Serverless Function — /api/chat
 * Self-contained 6-stage pipeline using Vercel AI SDK.
 * No imports from server/ directory to avoid Playwright bundling issues.
 */
import { generateText, streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

export const config = { maxDuration: 60 };

// ── Providers ───────────────────────────────────────────────────────────────
const google = process.env.GEMINI_API_KEY
  ? createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const openai = process.env.OPENAI_API_KEY
  ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const DEFAULT_MODEL = 'gpt-5-mini';

function getModel(name) {
  if (name?.startsWith('gemini')) return google?.(name) ?? google?.(DEFAULT_MODEL);
  if (name?.startsWith('gpt') || name?.startsWith('o1') || name?.startsWith('o3') || name?.startsWith('o4')) {
    return openai?.(name);
  }
  return google?.(name ?? DEFAULT_MODEL) ?? openai?.(name ?? 'gpt-5-mini');
}

// ── SSE helper ──────────────────────────────────────────────────────────────
function sendSSE(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
}

// ── Stage 1: Screening ─────────────────────────────────────────────────────
async function screenQuery(query, model) {
  try {
    const { text } = await generateText({
      model: getModel(model),
      system: `You are a content safety classifier. Analyze the user message and respond with JSON:
{
  "safe": true/false,
  "category": "safe" | "inappropriate" | "harmful" | "spam",
  "reason": "brief explanation"
}
IMPORTANT: Default to safe=true. Only flag as unsafe for explicit malware creation, CSAM, weapons instructions, or targeted harassment. Everything else is safe.`,
      messages: [{ role: 'user', content: query }],
      temperature: 0.1,
      maxTokens: 400,
    });
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return { safe: parsed.safe !== false, category: parsed.category || 'safe', reason: parsed.reason || '' };
  } catch {
    return { safe: true, category: 'safe', reason: 'Screening skipped' };
  }
}

// ── Stage 2: Routing ────────────────────────────────────────────────────────
async function classifyQuery(query, model) {
  try {
    const { text } = await generateText({
      model: getModel(model),
      system: `You are a query classifier. Respond with JSON:
{
  "category": "general"|"research"|"coding"|"math"|"creative"|"interactive",
  "suggestedAgents": ["agent1"],
  "reasoning": "why"
}
Available agents: "general", "research", "coding", "math", "creative", "interactive".
Rules:
- Creating something visual/interactive (games, charts, animations, calculators, visualizations, demos, graphs, infographics, dashboards, timelines, diagrams, SVG, "그려줘", "시각화") → "interactive"
- Drawing, visualizing, or diagramming something → "interactive"
- Factual/current events → "research"
- Code concepts/debugging/algorithms (NOT visual output) → "coding"
- Math/statistics → "math"
- Creative writing → "creative"
- Simple greetings → "general"
- When unsure → ["research", "general"]`,
      messages: [{ role: 'user', content: query }],
      temperature: 0.2,
      maxTokens: 400,
    });
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const agents = Array.isArray(parsed.suggestedAgents) && parsed.suggestedAgents.length > 0
      ? parsed.suggestedAgents
      : ['general'];
    // Interactive runs alone — it provides its own intro/outro text
    if (agents.includes('interactive')) {
      return { suggestedAgents: ['interactive'], reasoning: parsed.reasoning || '' };
    }
    return { suggestedAgents: agents, reasoning: parsed.reasoning || '' };
  } catch {
    return { suggestedAgents: ['general'], reasoning: 'Classification failed, using general' };
  }
}

// ── Web Search (DuckDuckGo HTML — no API key, no CAPTCHA) ─────────────────
const SEARCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BLOCKED_DOMAINS = /coupang\.com|naver\.com|daum\.net|tistory\.com|instagram\.com|facebook\.com|twitter\.com|x\.com/i;

async function webSearch(query, maxResults = 5) {
  const resp = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'User-Agent': SEARCH_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    },
    body: `q=${encodeURIComponent(query)}&kl=kr-kr`,
    redirect: 'follow',
  });
  if (!resp.ok) return { query, results: [], pageContent: '', source: '' };
  const html = await resp.text();
  const results = [];
  const blocks = html.split(/class="result\s+results_links/);
  for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
    const block = blocks[i];
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]*)"/);
    if (!urlMatch) continue;
    let url = urlMatch[1];
    const uddg = url.match(/uddg=([^&]*)/);
    if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch {} }
    if (url.startsWith('//')) url = 'https:' + url;
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    if (url && title) results.push({ title, url, snippet });
  }
  // Fetch content from first accessible result
  let pageContent = '';
  let source = 'duckduckgo.com';
  for (const r of results.slice(0, 3)) {
    if (!r.url || BLOCKED_DOMAINS.test(r.url)) continue;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const pr = await fetch(r.url, {
        headers: { 'User-Agent': SEARCH_UA, 'Accept': 'text/html', 'Accept-Language': 'ko-KR,ko;q=0.9' },
        signal: ctrl.signal, redirect: 'follow',
      });
      clearTimeout(timer);
      if (!pr.ok) continue;
      const ct = pr.headers.get('content-type') || '';
      if (!ct.includes('text/html')) continue;
      const ph = await pr.text();
      const cleaned = ph
        .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '').replace(/<aside[\s\S]*?<\/aside>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ').trim();
      if (cleaned.length > 100) { pageContent = cleaned.slice(0, 3000); source = r.url; break; }
    } catch { /* next */ }
  }
  return { query, results, pageContent, source };
}

// ── Stage 3: Agent execution ────────────────────────────────────────────────
const AGENT_LABELS = {
  research: '리서치 에이전트',
  coding: '코딩 에이전트',
  math: '수학 에이전트',
  creative: '크리에이티브 에이전트',
  general: '일반 에이전트',
  interactive: '인터랙티브 에이전트',
};

const AGENT_PROMPTS = {
  general: {
    system: 'You are a friendly, helpful AI assistant. Be concise and warm. Respond in the same language as the user.',
    temperature: 0.7,
    maxTokens: 2048,
  },
  research: {
    system: 'You are a research specialist. Provide thorough, well-informed answers using your training knowledge. Include specific details and cite facts when possible. Respond in the same language as the user.',
    temperature: 0.5,
    maxTokens: 2048,
  },
  coding: {
    system: 'You are a coding specialist. Write clean, production-ready code. Include error handling. Explain your approach. Respond in the same language as the user.',
    temperature: 0.3,
    maxTokens: 4096,
  },
  math: {
    system: 'You are a math specialist. Show work step by step. Use LaTeX ($..$ inline, $$...$$ display). Verify your answers. Respond in the same language as the user.',
    temperature: 0.2,
    maxTokens: 4096,
  },
  creative: {
    system: 'You are a creative specialist. Be imaginative and original. Adapt tone to the request. Respond in the same language as the user.',
    temperature: 0.8,
    maxTokens: 4096,
  },
  interactive: {
    system: `You are a visual & interactive content creator. You render content directly in the user's chat.

## MODE SELECTION — choose ONE mode per response:

### MODE A: SVG+CSS (preferred for static visuals)
Use for: charts, graphs, infographics, dashboards, timelines, data cards, diagrams, comparisons, statistics, visual summaries.
Advantages: lightweight, instant render, beautiful animations, no JS needed.

OUTPUT FORMAT for SVG mode:
\\\`\\\`\\\`html
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:0;background:transparent;display:flex;justify-content:center}</style>
</head><body>
<svg viewBox="0 0 WIDTH HEIGHT" xmlns="http://www.w3.org/2000/svg">
  <style>/* CSS here */</style>
  <!-- SVG content -->
</svg>
</body></html>
\\\`\\\`\\\`

SVG+CSS RULES:
1. ALWAYS set viewBox. ALWAYS include xmlns="http://www.w3.org/2000/svg".
2. Use CSS animations: fadeSlideUp, growBar (transform-origin:center bottom), drawLine (stroke-dasharray+dashoffset), animation-delay (0.1~0.2s intervals).
3. opacity:0 + animation-fill-mode:forwards for animated elements.
4. Use gradients and filters in <defs> for polish.
5. Good colors: blues (#3b82f6), greens (#10b981), ambers (#f59e0b), reds (#ef4444).
6. NO JavaScript in SVG mode.

### MODE B: HTML+JS (for truly interactive content)
Use for: games, calculators, quizzes, timers, interactive tools, simulations, anything requiring user interaction.

HTML+JS RULES:
1. Self-contained: all CSS in <style>, all JS in <script>. NO external CDN/links EXCEPT KaTeX (see below).
2. Must work in sandboxed iframe (no localStorage, no fetch).
3. Modern CSS: flexbox, grid, transitions.
4. **KaTeX for math rendering**: When ANY math formula appears, include these 3 tags in <head>:
   \\\`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">\\\`
   \\\`<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>\\\`
   \\\`<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]})"></script>\\\`
   Then just write math with dollar-sign delimiters: inline \\\`$PV=nRT$\\\`, display \\\`$$E=mc^2$$\\\`.
   Auto-render converts all \\\`$...$\\\` and \\\`$$...$$\\\` into beautiful rendered math.
   ALWAYS use for: formulas, variable labels, greek letters (\\\`$\\\\alpha$\\\`), fractions (\\\`$\\\\frac{1}{f}$\\\`).

## OUTPUT FORMAT (follow STRICTLY):
Your response has exactly 3 parts. Do NOT include labels like "STEP", "INTRO", "OUTRO" — just the content itself.

Part 1: 1-2 sentences describing what you will show. Natural conversational tone.
(blank line)
\\\`\\\`\\\`html
(your code)
\\\`\\\`\\\`
(blank line)
Part 3: 1-3 sentences — usage tips or brief explanation of the content.

EXAMPLE:
삼각함수의 원리를 단위원으로 시각화해 보여드리겠습니다.

\\\`\\\`\\\`html
<!DOCTYPE html>...
\\\`\\\`\\\`

슬라이더를 움직여 각도를 변경하면 sin, cos 값이 실시간으로 변합니다.

RULES:
1. COMPACT code. 2. Korean UI text when user writes Korean. 3. Empty line before \\\`\\\`\\\`html. 4. Same language as user. 5. Visually polished. 6. No labels/headers/markers — just natural sentences and code fence.
7. **LaTeX for ALL math**: In Part 1 and Part 3 text, ALWAYS write math using LaTeX: inline \\\`$E=mc^2$\\\`, display \\\`$$F=ma$$\\\`. Includes variable names ($x$), Greek letters ($\\\\alpha$), formulas, equations. Text is rendered with KaTeX — plain text math won't render.

## CRITICAL DESIGN RULE — SIZE & LAYOUT:
Your content is rendered inside a chat bubble in an iframe (100% width of bubble).
RESPONSIVE WIDTH:
- Content displays at ~900px desktop, ~350px mobile. ALWAYS use width:100%, NEVER fixed px widths.
- SVG: viewBox width=800, add width="100%". SVGs auto-scale with viewBox.
- HTML: width:100%;max-width:100%;box-sizing:border-box on containers. Use % or flex, not fixed px.
- Cards in a row: display:flex;flex-wrap:wrap;gap:12px (reflow on narrow screens).
HEIGHT: Only as much vertical space as content needs. SVG viewBox height tightly fits content.
BACKGROUND: NEVER wrap in card/box with background/border/shadow. body: margin:0;padding:0;background:transparent. SVG bg: fill="none". Inner cards OK, outermost transparent.

## FORMULA WIDGET FORMAT (for math/science educational content)
When the user asks to explore, visualize, or understand a formula/equation/law (e.g. PV=nRT, F=ma, a²+b²=c², Ohm's Law, Snell's Law, etc.), use this two-panel interactive widget format. Always use MODE B (HTML+JS).

### LAYOUT: Two vertically stacked panels
Control Panel (white bg) on top: formula display + parameter sliders with lock toggles.
Visualization Panel (#F8F8FA bg) below: interactive diagram that reacts to slider changes.

### CONTROL PANEL:
1. Formula at top center: write $$PV = nRT$$ in HTML — KaTeX auto-render handles it. Style: font-size ~24px, color #333, text-align center.
2. One row per parameter: Label uses $P$, $V$, $\\theta$ etc. — auto-render makes them beautiful math | Value (sans-serif 14px #333, 1 decimal) | Slider (track 4px #E0E0E0, thumb 18px circle white/#4A90D9) | Lock toggle (○/●)
3. Lock mechanism: locked(●)=constant. Dragging one unlocked slider auto-adjusts another unlocked param to maintain equality. Default lock one param.
4. Real-time updates as slider drags.

### VISUALIZATION PANEL:
1. Simplified schematic diagram, NOT photorealistic.
2. Colors: primary #4A90D9, fill rgba(74,144,217,0.25), structural #B0B0B0, labels #666.
3. Real-time updates with smooth transitions.
4. Dashed lines for virtual/projected paths. Minimal text labels near elements.
5. At least one visual property changes per adjustable parameter.

### EXAMPLE FORMULAS & DIAGRAMS:
PV=nRT → cylinder+piston+particles | 1/f=1/dₒ+1/dᵢ → lens+rays | a²+b²=c² → triangle+squares | F=ma → block+arrows | V=IR → circuit | λf=c → animated wave | F=kx → spring+mass | n₁sinθ₁=n₂sinθ₂ → refraction`,
    temperature: 0.7,
    maxTokens: 8192,
  },
};

async function runAgent(agentType, messages, model) {
  // Research agent: use real web search
  if (agentType === 'research') {
    return runResearchAgent(messages, model);
  }
  const config = AGENT_PROMPTS[agentType] || AGENT_PROMPTS.general;
  const { text } = await generateText({
    model: getModel(model),
    system: config.system,
    messages,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });
  return text;
}

async function runResearchAgent(messages, model) {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  // Generate search query
  const { text: rawQuery } = await generateText({
    model: getModel(model),
    messages: [{ role: 'user', content: `Convert this question into a web search query. Output ONLY the search query text, no quotes.\n\nQuestion: ${lastUserMsg}` }],
    temperature: 0.3, maxTokens: 100,
  });
  const query = rawQuery.trim().replace(/^["']|["']$/g, '');
  const finalQuery = query.length >= 5 ? query : lastUserMsg;

  try {
    const searchResult = await webSearch(finalQuery);
    if (searchResult.results.length > 0) {
      const context = [
        `Search query: "${searchResult.query}"`, `Source: ${searchResult.source}`, '',
        'Search results:',
        ...searchResult.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`),
      ];
      if (searchResult.pageContent) {
        context.push('', 'Page content:', searchResult.pageContent);
      }
      const { text } = await generateText({
        model: getModel(model),
        system: `You are a research specialist. Analyze the web search results and provide a thorough answer. Do NOT include URLs or source sections. Respond in the same language as the user.`,
        messages: [
          ...messages,
          { role: 'assistant', content: `Web search results:\n\n${context.join('\n')}` },
          { role: 'user', content: 'Based on the search results, provide a comprehensive answer to my original question.' },
        ],
        temperature: 0.5, maxTokens: 2048,
      });
      return text;
    }
  } catch (err) {
    console.error('[api/chat] Search failed:', err.message);
  }
  // Fallback: LLM knowledge
  const { text } = await generateText({
    model: getModel(model), system: AGENT_PROMPTS.research.system,
    messages, temperature: 0.5, maxTokens: 2048,
  });
  return text;
}

// ── Stage 4: Synthesis ──────────────────────────────────────────────────────
function buildSynthesisSystem(results) {
  if (results.length === 1) {
    return `You are a helpful AI assistant. Below is reference information:

<reference>
${results[0].result}
</reference>

Present the information naturally as your own response. Do NOT mention agents or internal processing.
Do NOT use meta-commentary. Do NOT include any URLs, links, or "출처"/"참고"/"References" sections — source citations are handled separately.
Use inline code (\`like this\`) for short terms/names, NOT fenced code blocks. Only use fenced code blocks for multi-line code.
Respond directly in the same language as the user.`;
  }

  const sources = results.map((r, i) => `<source${i + 1}>\n${r.result}\n</source${i + 1}>`).join('\n\n');
  return `You are a helpful AI assistant. Below are reference materials:

${sources}

Combine into one coherent response. Do NOT mention sources or agents.
Do NOT include any URLs, links, or "출처"/"참고"/"References" sections — source citations are handled separately.
Use inline code (\`like this\`) for short terms/names, NOT fenced code blocks. Only use fenced code blocks for multi-line code.
Respond directly in the same language as the user. Use markdown where appropriate.`;
}

// ── Follow-up generation ────────────────────────────────────────────────────
async function generateFollowUps(answer, userQuery, model) {
  try {
    const { text } = await generateText({
      model: getModel(model),
      messages: [
        { role: 'user', content: userQuery },
        { role: 'assistant', content: answer.slice(0, 1500) },
        { role: 'user', content: '위 답변을 바탕으로 사용자가 이어서 물어볼 만한 후속 질문 3개를 JSON 배열 형태로만 응답해주세요. 예: ["질문1", "질문2", "질문3"]' },
      ],
      temperature: 0.6,
      maxTokens: 600,
    });
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      return arr.filter((q) => typeof q === 'string' && q.trim()).slice(0, 3);
    }
  } catch { /* skip */ }
  return [];
}

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { messages = [], model: selectedModel } = req.body || {};
  const mainModel = selectedModel || DEFAULT_MODEL;
  const fastModel = DEFAULT_MODEL;

  const apiMessages = messages.map((m) => ({
    role: m.role || 'user',
    content: m.content || '',
  }));
  const lastUserMsg = [...apiMessages].reverse().find((m) => m.role === 'user')?.content || '';

  try {
    // ── Stage 1: Screening ──────────────────────────────────────────────
    sendSSE(res, 'status', 'screening');
    sendSSE(res, 'thinking_update', { stage: 'screening', text: '안전성 검사 중...' });
    const screening = await screenQuery(lastUserMsg, fastModel);

    if (!screening.safe) {
      sendSSE(res, 'status', 'rejected');
      sendSSE(res, 'thinking_update', { stage: 'screening', text: `안전성 검사 불통과: ${screening.reason}` });
      sendSSE(res, 'content', '죄송합니다. 해당 요청은 처리할 수 없습니다.');
      sendSSE(res, 'status', 'streaming');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    sendSSE(res, 'thinking_update', { stage: 'screening', text: '안전성 검사 통과 ✓' });

    // ── Stage 2: Routing ────────────────────────────────────────────────
    sendSSE(res, 'status', 'routing');
    sendSSE(res, 'thinking_update', { stage: 'routing', text: '에이전트 선택 중...' });
    const routing = await classifyQuery(lastUserMsg, fastModel);

    const agentList = routing.suggestedAgents.filter((a) => AGENT_LABELS[a]);
    if (agentList.length === 0) agentList.push('general');
    const agentLabels = agentList.map((a) => AGENT_LABELS[a]);

    sendSSE(res, 'routing_result', { agents: agentList, labels: agentLabels, reasoning: routing.reasoning });
    sendSSE(res, 'thinking_update', { stage: 'routing', text: `${agentLabels.join(', ')} 선택됨 ✓` });
    sendSSE(res, 'status', 'search_skipped');

    // ── Stage 3: Agent Execution ────────────────────────────────────────
    sendSSE(res, 'status', 'executing');

    // If interactive agent is included, run it separately so we can
    // stream text results immediately without waiting for it
    const hasInteractive = agentList.includes('interactive');
    const textAgentList = hasInteractive ? agentList.filter((a) => a !== 'interactive') : agentList;

    let interactivePromise = null;
    if (hasInteractive) {
      sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${AGENT_LABELS.interactive} 실행 중...` });
      interactivePromise = runAgent('interactive', apiMessages, mainModel)
        .then((result) => {
          sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${AGENT_LABELS.interactive} 완료 ✓` });
          return { result, success: true };
        })
        .catch((err) => {
          console.error('[api/chat] Interactive agent error:', err.message);
          sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${AGENT_LABELS.interactive} 실패 ✗` });
          return { result: '', success: false };
        });
    }

    // Dispatch text agents — these complete fast
    const agentResults = await Promise.all(
      textAgentList.map(async (agentType) => {
        const label = AGENT_LABELS[agentType];
        sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${label} 실행 중...` });
        try {
          const result = await runAgent(agentType, apiMessages, agentType === 'general' ? fastModel : mainModel);
          sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${label} 완료 ✓` });
          return { agentName: label, result, success: true };
        } catch (err) {
          console.error(`[api/chat] ${label} error:`, err.message);
          sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${label} 실패 ✗` });
          return { agentName: label, result: '', success: false, error: err.message };
        }
      }),
    );

    // Fallback
    let successfulResults = agentResults.filter((r) => r.success && r.result);
    if (successfulResults.length === 0 && textAgentList.length > 0) {
      sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: '에이전트 실패 — 일반 모드로 재시도 중...' });
      try {
        const result = await runAgent('general', apiMessages, fastModel);
        agentResults.push({ agentName: '일반 에이전트 (폴백)', result, success: true });
        successfulResults = agentResults.filter((r) => r.success && r.result);
      } catch {
        if (!interactivePromise) {
          sendSSE(res, 'content', '오류가 발생했습니다.');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
      }
    }

    // ── Stream text results immediately (don't wait for interactive) ──
    sendSSE(res, 'status', 'synthesize');
    sendSSE(res, 'thinking_update', { stage: 'synthesize', text: '결과 종합 중...' });
    sendSSE(res, 'status', 'streaming');

    let fullAnswer = '';
    let followUpPromise = null;

    if (successfulResults.length > 0) {
      const system = buildSynthesisSystem(successfulResults);
      const textStream = streamText({
        model: getModel(mainModel),
        system,
        messages: apiMessages,
        temperature: 0.7,
        maxTokens: 2048,
      });
      for await (const chunk of textStream.textStream) {
        fullAnswer += chunk;
        sendSSE(res, 'content', chunk);
        if (!followUpPromise && fullAnswer.length > 200) {
          followUpPromise = generateFollowUps(fullAnswer, lastUserMsg, fastModel);
        }
      }
    }

    // Now wait for interactive agent and send 3-part output: intro → html → outro
    if (interactivePromise) {
      const interactiveResult = await interactivePromise;
      if (interactiveResult.success && interactiveResult.result) {
        const raw = interactiveResult.result;
        const fenceMatch = raw.match(/```html\s*\n([\s\S]*?)```/);
        if (fenceMatch) {
          // STEP 1: Intro text (before the code fence)
          const beforeFence = raw.slice(0, fenceMatch.index).trim();
          if (beforeFence) sendSSE(res, 'content', beforeFence + '\n\n');
          // STEP 2: Interactive HTML content
          const htmlCode = fenceMatch[1].trim();
          sendSSE(res, 'interactive_html', htmlCode);
          // STEP 3: Outro text (after the code fence)
          const afterFence = raw.slice(raw.indexOf('```', fenceMatch.index + 3) + 3).trim();
          if (afterFence) sendSSE(res, 'content', '\n\n' + afterFence);
        } else {
          sendSSE(res, 'interactive_html', raw);
        }
      }
    }

    if (!followUpPromise) {
      followUpPromise = generateFollowUps(fullAnswer, lastUserMsg, fastModel);
    }
    const followUps = await followUpPromise;
    if (followUps.length > 0) sendSSE(res, 'follow_ups', followUps);

    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[api/chat] Error:', err);
    sendSSE(res, 'content', `오류가 발생했습니다: ${err.message}`);
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}
