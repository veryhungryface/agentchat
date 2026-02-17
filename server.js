/* global process */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const {
  GLM4_API_KEY,
  GLM4_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4',
  GLM4_MODEL = 'glm-5',
  ORCHESTRATOR_MODEL = process.env.GLM_ORCHESTRATOR_MODEL || 'glm-4.7-flash',
  RESPONSE_MODEL = process.env.GLM_RESPONSE_MODEL || GLM4_MODEL,
  TAVILY_API_KEY,
  PORT = 3001,
} = process.env;

const SEARCH_PLAN_FALLBACK = {
  shouldSearch: false,
  mode: 'none',
  primaryQueries: [],
  reason: 'Planner fallback: use internal reasoning only.',
};

const SECOND_SEARCH_FALLBACK = {
  needsMore: false,
  refinedQueries: [],
  reason: 'Follow-up search not required.',
};

const NO_SEARCH_HINTS = [
  /translate|translation|proofread|rewrite|summarize|summarise|paraphrase/i,
  /번역|요약|교정|맞춤법|문장 다듬/i,
  /write a poem|story|creative writing|brainstorm names/i,
  /시를 써|소설 써|창작|아이디어만/i,
];

const SEARCH_HINTS = [
  /latest|today|current|news|price|stock|release|version|update|official docs?/i,
  /recommend|comparison|compare|vs|best|top \d+/i,
  /최신|오늘|현재|뉴스|가격|주가|환율|업데이트|버전|공식 문서|추천|비교|리뷰/i,
  /설치|세팅|가이드|준비물|requirements|prerequisite/i,
];

function sendSSE(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
}

function toStringSafe(value) {
  return typeof value === 'string' ? value : '';
}

function extractFirstJsonObject(text) {
  const raw = toStringSafe(text).trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // continue
    }
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeSearchPlan(plan, originalQuery) {
  const safeQuery = toStringSafe(originalQuery).trim();

  if (!plan || typeof plan !== 'object') {
    return {
      ...SEARCH_PLAN_FALLBACK,
      primaryQueries: safeQuery ? [safeQuery] : [],
      shouldSearch: Boolean(safeQuery),
      mode: safeQuery ? 'single' : 'none',
    };
  }

  const shouldSearch = Boolean(plan.shouldSearch);
  const validModes = new Set(['none', 'single', 'multi']);
  let mode = validModes.has(plan.mode) ? plan.mode : shouldSearch ? 'single' : 'none';

  let primaryQueries = Array.isArray(plan.primaryQueries)
    ? plan.primaryQueries
        .map((q) => toStringSafe(q).trim())
        .filter(Boolean)
    : [];

  primaryQueries = [...new Set(primaryQueries)];

  if (shouldSearch && primaryQueries.length === 0 && safeQuery) {
    primaryQueries = [safeQuery];
  }

  if (!shouldSearch) {
    mode = 'none';
    primaryQueries = [];
  }

  if (mode !== 'multi') {
    primaryQueries = primaryQueries.slice(0, 1);
    if (shouldSearch && primaryQueries.length > 0) mode = 'single';
  } else {
    primaryQueries = primaryQueries.slice(0, 3);
    if (primaryQueries.length <= 1) mode = 'single';
  }

  return {
    shouldSearch,
    mode,
    primaryQueries,
    reason: toStringSafe(plan.reason) || SEARCH_PLAN_FALLBACK.reason,
  };
}

function normalizeSecondSearchDecision(decision) {
  if (!decision || typeof decision !== 'object') return SECOND_SEARCH_FALLBACK;

  const refinedQueries = Array.isArray(decision.refinedQueries)
    ? decision.refinedQueries
        .map((q) => toStringSafe(q).trim())
        .filter(Boolean)
    : toStringSafe(decision.refinedQuery)
      ? [toStringSafe(decision.refinedQuery).trim()]
      : [];

  const uniqueQueries = [...new Set(refinedQueries)].slice(0, 2);
  const needsMore = Boolean(decision.needsMore) && uniqueQueries.length > 0;

  return {
    needsMore,
    refinedQueries: needsMore ? uniqueQueries : [],
    reason: toStringSafe(decision.reason) || SECOND_SEARCH_FALLBACK.reason,
  };
}

function buildHeuristicSearchPlan(userQuery) {
  const query = toStringSafe(userQuery).trim();
  if (!query) {
    return {
      shouldSearch: false,
      mode: 'none',
      primaryQueries: [],
      reason: 'Empty query.',
    };
  }

  const isNoSearchCandidate = NO_SEARCH_HINTS.some((pattern) => pattern.test(query));
  const isSearchCandidate = SEARCH_HINTS.some((pattern) => pattern.test(query));

  let shouldSearch = true;
  if (isNoSearchCandidate && !isSearchCandidate) {
    shouldSearch = false;
  }

  if (!shouldSearch) {
    return {
      shouldSearch: false,
      mode: 'none',
      primaryQueries: [],
      reason: 'Heuristic: pure writing/editing request.',
    };
  }

  const multiHint = /\b(vs|versus|compare|comparison)\b|비교|차이|장단점|및|그리고/i.test(query);
  return {
    shouldSearch: true,
    mode: multiHint ? 'multi' : 'single',
    primaryQueries: [query],
    reason: multiHint
      ? 'Heuristic: likely multi-topic factual request.'
      : 'Heuristic: factual/procedural request; search recommended.',
  };
}

async function callGlmJson(
  messages,
  { model = ORCHESTRATOR_MODEL, timeoutMs = 9000, maxTokens = 220, temperature = 0.2 } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${GLM4_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GLM4_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GLM4 API error: ${res.status} - ${body}`);
    }

    const payload = await res.json();
    const content = payload.choices?.[0]?.message?.content;
    return extractFirstJsonObject(content);
  } finally {
    clearTimeout(timeout);
  }
}

async function callGlmText(
  messages,
  { model = ORCHESTRATOR_MODEL, timeoutMs = 7000, maxTokens = 120, temperature = 0.3 } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${GLM4_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GLM4_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GLM4 API error: ${res.status} - ${body}`);
    }

    const payload = await res.json();
    return toStringSafe(payload.choices?.[0]?.message?.content).trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function chatWithGlmStream(messages) {
  const res = await fetch(`${GLM4_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GLM4_API_KEY}`,
    },
    body: JSON.stringify({
      model: RESPONSE_MODEL,
      messages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GLM4 API error: ${res.status} - ${errText}`);
  }

  return res;
}

function buildThinkingFallback(stage, context = {}) {
  switch (stage) {
    case 'analyze_intent':
      return '질문의 핵심 의도를 먼저 정리하고 있습니다.';
    case 'decide_search':
      if (context.searchPlan?.shouldSearch) {
        return '정확한 답변을 위해 최신 정보를 확인할 웹검색이 필요하다고 판단했습니다.';
      }
      return '웹검색 없이도 답변 가능한 요청으로 판단했습니다.';
    case 'plan_queries':
      if (context.searchPlan?.shouldSearch) {
        return '검색에 사용할 쿼리와 확인 순서를 정리하고 있습니다.';
      }
      return '검색 단계는 건너뛰고 답변 준비로 바로 넘어갑니다.';
    case 'searching':
      return '신뢰 가능한 근거를 확보하기 위해 웹검색을 실행하고 있습니다.';
    case 'search_results':
      return `웹검색 결과에서 출처 ${context.sourceCount || 0}개를 확보했습니다.`;
    case 'analyzing':
      return '검색 결과를 검토해 누락 정보와 신뢰도를 확인하고 있습니다.';
    case 'searching_2':
      return '누락 정보를 보강하기 위해 추가 웹검색을 실행하고 있습니다.';
    case 'synthesize':
      return '검색 결과를 바탕으로 답변을 정리하고 있습니다.';
    case 'thinking':
      return '답변 초안을 마무리하고 곧 전달하겠습니다.';
    case 'error':
      return `진행 중 오류가 발생했습니다: ${toStringSafe(context.error) || '알 수 없는 오류'}`;
    default:
      return '응답 준비를 진행하고 있습니다.';
  }
}

async function generateThinkingNarration({ stage, userQuery, context = {} }) {
  const fallback = buildThinkingFallback(stage, context);
  if (!GLM4_API_KEY) return fallback;

  const lines = [
    `stage: ${stage}`,
    `user_query: ${toStringSafe(userQuery).slice(0, 240)}`,
  ];

  if (context.searchPlan) {
    lines.push(`search_should: ${Boolean(context.searchPlan.shouldSearch)}`);
    lines.push(`search_mode: ${toStringSafe(context.searchPlan.mode)}`);
    lines.push(`search_reason: ${toStringSafe(context.searchPlan.reason).slice(0, 200)}`);
    lines.push(`primary_queries: ${(context.searchPlan.primaryQueries || []).join(' | ').slice(0, 240)}`);
  }

  if (context.secondDecision) {
    lines.push(`needs_more: ${Boolean(context.secondDecision.needsMore)}`);
    lines.push(`decision_reason: ${toStringSafe(context.secondDecision.reason).slice(0, 200)}`);
  }

  if (typeof context.sourceCount === 'number') {
    lines.push(`source_count: ${context.sourceCount}`);
  }

  if (context.round) {
    lines.push(`round: ${context.round}`);
  }

  if (context.error) {
    lines.push(`error: ${toStringSafe(context.error).slice(0, 200)}`);
  }

  const messages = [
    {
      role: 'system',
      content: [
        'You are an orchestration narrator for a "Thinking" panel.',
        'Return exactly one Korean sentence.',
        'Keep it concise and natural, no bullet, no quotes, no markdown.',
        'Describe current 판단 and next action.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: lines.join('\n'),
    },
  ];

  try {
    const raw = await callGlmText(messages, {
      model: ORCHESTRATOR_MODEL,
      maxTokens: 90,
      timeoutMs: 7000,
      temperature: 0.25,
    });
    const normalized = toStringSafe(raw)
      .replace(/```[\s\S]*?```/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);

    return normalized || fallback;
  } catch (err) {
    console.error('Thinking narration error:', err.message);
    return fallback;
  }
}

async function emitThinking(res, { stage, userQuery, context }) {
  const text = await generateThinkingNarration({ stage, userQuery, context });
  if (text) sendSSE(res, 'thinking_text', text);
}

async function searchWeb(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: 10,
      include_answer: true,
      include_raw_content: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Tavily API error: ${res.status}`);
  }

  const data = await res.json();
  return {
    answer: toStringSafe(data.answer),
    results: (data.results || []).map((r) => ({
      title: toStringSafe(r.title),
      url: toStringSafe(r.url),
      content: toStringSafe(r.raw_content || r.content),
    })),
  };
}

async function buildInitialSearchPlan(userQuery, conversationMessages) {
  const heuristicPlan = normalizeSearchPlan(buildHeuristicSearchPlan(userQuery), userQuery);

  if (!GLM4_API_KEY) {
    return heuristicPlan;
  }

  const briefHistory = (conversationMessages || [])
    .slice(-6)
    .map((m) => `${m.role}: ${toStringSafe(m.content).slice(0, 300)}`)
    .join('\n');

  const plannerMessages = [
    {
      role: 'system',
      content:
        'You are a search-orchestration planner. Decide if web retrieval is required before answering. Return JSON only.',
    },
    {
      role: 'user',
      content: [
        'Decide web search strategy for this request.',
        '',
        `User query: "${userQuery}"`,
        '',
        'Recent conversation (may be empty):',
        briefHistory || '(none)',
        '',
        'Rules:',
        '- shouldSearch=true when freshness, external facts, citation-grade grounding, or URL/source verification is needed.',
        '- shouldSearch=false for pure reasoning, writing, translation, coding from provided context, or subjective advice.',
        '- mode=single for one coherent lookup question.',
        '- mode=multi for clearly distinct subtopics requiring separate lookups.',
        '- primaryQueries should be 0 items if mode=none, 1 item for single, up to 3 items for multi.',
        '',
        'Return JSON schema exactly:',
        '{"shouldSearch": boolean, "mode": "none"|"single"|"multi", "primaryQueries": string[], "reason": string}',
      ].join('\n'),
    },
  ];

  try {
    const plan = await callGlmJson(plannerMessages, {
      model: ORCHESTRATOR_MODEL,
      maxTokens: 260,
      timeoutMs: 9000,
    });
    const normalized = normalizeSearchPlan(plan, userQuery);

    if (!normalized.primaryQueries.length && heuristicPlan.primaryQueries.length) {
      return {
        ...normalized,
        primaryQueries: heuristicPlan.primaryQueries,
      };
    }

    return normalized;
  } catch (err) {
    console.error('Search planner error:', err.message);
    return heuristicPlan;
  }
}

async function shouldDoSecondSearch(userQuery, searchPlan, firstRoundEntries) {
  if (!GLM4_API_KEY || !firstRoundEntries.length) {
    return SECOND_SEARCH_FALLBACK;
  }

  const digest = firstRoundEntries
    .map((entry, idx) => {
      const top = entry.results
        .slice(0, 3)
        .map((r, i) => `${i + 1}. ${r.title} :: ${r.content.slice(0, 150)}`)
        .join('\n');
      return [
        `[Primary #${idx + 1}] query=${entry.query}`,
        `answer=${entry.answer || '(none)'}`,
        top || '(no results)',
      ].join('\n');
    })
    .join('\n\n');

  const messages = [
    {
      role: 'system',
      content:
        'You evaluate retrieval completeness. Return JSON only. Request follow-up search only if there are major factual gaps.',
    },
    {
      role: 'user',
      content: [
        `User query: "${userQuery}"`,
        `Initial mode: ${searchPlan.mode}`,
        '',
        'Primary search digest:',
        digest,
        '',
        'Return JSON schema exactly:',
        '{"needsMore": boolean, "refinedQueries": string[], "reason": string}',
        'If needsMore=false, refinedQueries must be empty.',
        'If needsMore=true, provide 1-2 concise refined queries.',
      ].join('\n'),
    },
  ];

  try {
    const decision = await callGlmJson(messages, {
      model: ORCHESTRATOR_MODEL,
      maxTokens: 220,
      timeoutMs: 9000,
    });
    return normalizeSecondSearchDecision(decision);
  } catch (err) {
    console.error('Second search decision error:', err.message);
    return SECOND_SEARCH_FALLBACK;
  }
}

async function runSearchBatch({ queries, round, res }) {
  const normalized = [...new Set((queries || []).map((q) => toStringSafe(q).trim()).filter(Boolean))];
  if (!normalized.length) return [];

  const settled = await Promise.allSettled(
    normalized.map(async (query) => {
      const data = await searchWeb(query);
      return {
        round,
        query,
        answer: data.answer,
        results: data.results,
      };
    }),
  );

  const entries = [];
  settled.forEach((item, idx) => {
    const query = normalized[idx];
    if (item.status === 'fulfilled') {
      entries.push(item.value);
      sendSSE(res, 'search', item.value);
    } else {
      sendSSE(res, 'search_error', {
        round,
        query,
        error: item.reason?.message || 'Search failed',
      });
    }
  });

  return entries;
}

function buildSearchContext(entries) {
  if (!entries.length) return '';

  return entries
    .map((entry, idx) => {
      const resultLines = entry.results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nSnippet: ${r.content}`)
        .join('\n\n');

      return [
        `Search block ${idx + 1}`,
        `Round: ${entry.round}`,
        `Query: ${entry.query}`,
        `Tavily answer: ${entry.answer || '(none)'}`,
        resultLines || '(no results)',
      ].join('\n');
    })
    .join('\n\n----\n\n');
}

function buildFinalMessages(messages, searchEntries) {
  const hasSearch = searchEntries.length > 0;
  const context = buildSearchContext(searchEntries);
  const systemPrompt = hasSearch
    ? [
        'You are a careful assistant.',
        'Use the provided search evidence when relevant.',
        'When citing retrieved facts, include markdown links to source URLs.',
        'If evidence is weak or conflicting, say so explicitly.',
        '',
        '[SEARCH CONTEXT START]',
        context,
        '[SEARCH CONTEXT END]',
      ].join('\n')
    : 'You are a helpful assistant. Answer directly and clearly.';

  return [
    { role: 'system', content: systemPrompt },
    ...(messages || []).filter((m) => m?.role === 'user' || m?.role === 'assistant'),
  ];
}

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
      return res.status(400).json({ error: 'last message must be from user' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    res.write(': connected\n\n');

    sendSSE(res, 'status', 'analyze_intent');
    await emitThinking(res, {
      stage: 'analyze_intent',
      userQuery: lastMessage.content,
    });

    sendSSE(res, 'status', 'decide_search');
    const searchPlan = await buildInitialSearchPlan(lastMessage.content, messages);
    sendSSE(res, 'search_plan', searchPlan);
    await emitThinking(res, {
      stage: 'decide_search',
      userQuery: lastMessage.content,
      context: { searchPlan },
    });

    sendSSE(res, 'status', 'plan_queries');
    await emitThinking(res, {
      stage: 'plan_queries',
      userQuery: lastMessage.content,
      context: { searchPlan },
    });

    let allSearchEntries = [];

    if (searchPlan.shouldSearch && TAVILY_API_KEY) {
      sendSSE(res, 'status', 'searching');
      await emitThinking(res, {
        stage: 'searching',
        userQuery: lastMessage.content,
        context: { searchPlan },
      });

      const firstRoundEntries = await runSearchBatch({
        queries: searchPlan.primaryQueries,
        round: 1,
        res,
      });

      allSearchEntries = [...firstRoundEntries];
      await emitThinking(res, {
        stage: 'search_results',
        userQuery: lastMessage.content,
        context: { round: 1, sourceCount: firstRoundEntries.reduce((acc, item) => acc + item.results.length, 0) },
      });

      if (firstRoundEntries.length > 0) {
        sendSSE(res, 'status', 'analyzing');
        await emitThinking(res, {
          stage: 'analyzing',
          userQuery: lastMessage.content,
          context: { searchPlan },
        });
        const secondDecision = await shouldDoSecondSearch(
          lastMessage.content,
          searchPlan,
          firstRoundEntries,
        );
        sendSSE(res, 'search_decision', secondDecision);
        await emitThinking(res, {
          stage: 'analyzing',
          userQuery: lastMessage.content,
          context: { searchPlan, secondDecision },
        });

        if (secondDecision.needsMore) {
          sendSSE(res, 'status', 'searching_2');
          await emitThinking(res, {
            stage: 'searching_2',
            userQuery: lastMessage.content,
            context: { secondDecision },
          });
          const secondRoundEntries = await runSearchBatch({
            queries: secondDecision.refinedQueries,
            round: 2,
            res,
          });
          allSearchEntries = [...allSearchEntries, ...secondRoundEntries];
          await emitThinking(res, {
            stage: 'search_results',
            userQuery: lastMessage.content,
            context: { round: 2, sourceCount: secondRoundEntries.reduce((acc, item) => acc + item.results.length, 0) },
          });
        }
      } else {
        sendSSE(res, 'status', 'search_failed');
        await emitThinking(res, {
          stage: 'error',
          userQuery: lastMessage.content,
          context: { error: '1차 검색 결과를 확보하지 못했습니다.' },
        });
      }
    } else {
      sendSSE(res, 'status', 'search_skipped');
      await emitThinking(res, {
        stage: 'plan_queries',
        userQuery: lastMessage.content,
        context: { searchPlan },
      });
      if (searchPlan.shouldSearch && !TAVILY_API_KEY) {
        sendSSE(res, 'search_error', {
          round: 1,
          query: searchPlan.primaryQueries[0] || '',
          error: 'TAVILY_API_KEY is missing. Search is skipped.',
        });
        await emitThinking(res, {
          stage: 'error',
          userQuery: lastMessage.content,
          context: { error: 'TAVILY_API_KEY is missing. Search is skipped.' },
        });
      }
    }

    sendSSE(res, 'status', 'synthesize');
    await emitThinking(res, {
      stage: 'synthesize',
      userQuery: lastMessage.content,
      context: { searchPlan },
    });

    const finalMessages = buildFinalMessages(messages, allSearchEntries);

    sendSSE(res, 'status', 'thinking');
    await emitThinking(res, {
      stage: 'thinking',
      userQuery: lastMessage.content,
      context: { searchPlan },
    });
    const glmRes = await chatWithGlmStream(finalMessages);

    sendSSE(res, 'status', 'streaming');
    const reader = glmRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) sendSSE(res, 'content', content);
        } catch {
          // ignore malformed stream line
        }
      }
    }

    res.end();
  } catch (err) {
    console.error('Chat error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!toStringSafe(query).trim()) {
      return res.status(400).json({ error: 'query is required' });
    }

    if (!TAVILY_API_KEY) {
      return res.status(500).json({ error: 'TAVILY_API_KEY is missing' });
    }

    const data = await searchWeb(query);
    res.json(data);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


