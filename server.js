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
  primaryResultCount: 0,
  reason: 'Planner fallback: use internal reasoning only.',
};

const SECOND_SEARCH_FALLBACK = {
  needsMore: false,
  refinedQueries: [],
  additionalResultCount: 0,
  reason: 'Follow-up search not required.',
};

const SEARCH_RESULT_LIMITS = {
  primary: { min: 3, max: 12, defaultSingle: 5, defaultMulti: 4 },
  followup: { min: 5, max: 15, default: 10 },
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

function sanitizeSearchText(text, maxLen = 420) {
  const cleaned = toStringSafe(text)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[#*_>|{}[\]]/g, ' ')
    .trim();

  if (!cleaned) return '';
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

function normalizeTextForCompare(text) {
  return toStringSafe(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^0-9a-z가-힣\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toBigrams(text) {
  const src = normalizeTextForCompare(text).replace(/\s+/g, '');
  if (!src) return [];
  if (src.length === 1) return [src];
  const arr = [];
  for (let i = 0; i < src.length - 1; i += 1) {
    arr.push(src.slice(i, i + 2));
  }
  return arr;
}

function diceSimilarity(a, b) {
  const aa = toBigrams(a);
  const bb = toBigrams(b);
  if (!aa.length || !bb.length) return 0;

  const map = new Map();
  aa.forEach((item) => map.set(item, (map.get(item) || 0) + 1));

  let overlap = 0;
  bb.forEach((item) => {
    const cnt = map.get(item) || 0;
    if (cnt > 0) {
      overlap += 1;
      map.set(item, cnt - 1);
    }
  });

  return (2 * overlap) / (aa.length + bb.length);
}

function isNearDuplicateText(text, history = []) {
  const recent = (history || []).slice(-6);
  return recent.some((prev) => diceSimilarity(prev, text) >= 0.6);
}

function toIntSafe(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, toIntSafe(value, min)));
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
      primaryResultCount: safeQuery ? SEARCH_RESULT_LIMITS.primary.defaultSingle : 0,
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

  const defaultPrimaryCount =
    mode === 'multi'
      ? SEARCH_RESULT_LIMITS.primary.defaultMulti
      : SEARCH_RESULT_LIMITS.primary.defaultSingle;

  const primaryResultCount = shouldSearch
    ? clampInt(
        plan.primaryResultCount ?? plan.primaryMaxResults ?? plan.resultCount ?? defaultPrimaryCount,
        SEARCH_RESULT_LIMITS.primary.min,
        SEARCH_RESULT_LIMITS.primary.max,
      )
    : 0;

  return {
    shouldSearch,
    mode,
    primaryQueries,
    primaryResultCount,
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
  const additionalResultCount = needsMore
    ? clampInt(
        decision.additionalResultCount ??
          decision.additionalMaxResults ??
          decision.maxResults ??
          decision.resultCount ??
          SEARCH_RESULT_LIMITS.followup.default,
        SEARCH_RESULT_LIMITS.followup.min,
        SEARCH_RESULT_LIMITS.followup.max,
      )
    : 0;

  return {
    needsMore,
    refinedQueries: needsMore ? uniqueQueries : [],
    additionalResultCount,
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
    primaryResultCount: multiHint
      ? SEARCH_RESULT_LIMITS.primary.defaultMulti
      : SEARCH_RESULT_LIMITS.primary.defaultSingle,
    reason: multiHint
      ? 'Heuristic: likely multi-topic factual request.'
      : 'Heuristic: factual/procedural request; search recommended.',
  };
}

function normalizeQueryArray(rawQueries, maxQueries = 3) {
  return [...new Set((rawQueries || []).map((q) => toStringSafe(q).trim()).filter(Boolean))].slice(
    0,
    maxQueries,
  );
}

function keywordizeQueryText(text) {
  let q = toStringSafe(text)
    .replace(/[“”"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  q = q.replace(/[?.!]+$/g, '').trim();
  q = q
    .replace(/\b(please|tell me|show me|help me|can you|could you)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tailPatterns = [
    /(알려줘|알려주세요|찾아줘|검색해줘|정리해줘|요약해줘|설명해줘|만들어줘|추천해줘|해줘|해주세요)$/i,
    /(해줄래|해줄 수 있어|부탁해)$/i,
  ];
  tailPatterns.forEach((pattern) => {
    q = q.replace(pattern, '').trim();
  });

  q = q.replace(/\s+/g, ' ').trim();
  if (!q) return '';
  return q.slice(0, 90).trim();
}

function enforceOptimizedQueryQuality(queries, userQuery, mode, maxQueries) {
  const source = normalizeQueryArray(queries, maxQueries);
  const userNorm = normalizeForCompare(userQuery);

  const adjusted = source.map((query) => {
    let next = keywordizeQueryText(query) || query;
    const nextNorm = normalizeForCompare(next);

    if (!nextNorm) next = query;

    if (normalizeForCompare(next) === userNorm) {
      const base = keywordizeQueryText(userQuery) || next;
      if (normalizeForCompare(base) !== userNorm) {
        next = base;
      } else {
        const suffix = mode === 'followup' ? ' 심화' : ' 최신 정보';
        next = `${base}${suffix}`.trim();
      }
    }

    return next.slice(0, 90).trim();
  });

  return normalizeQueryArray(adjusted, maxQueries);
}

function normalizeForCompare(text) {
  return toStringSafe(text)
    .toLowerCase()
    .replace(/[?.!,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFollowUpFallback(userQuery) {
  const raw = toStringSafe(userQuery).replace(/\s+/g, ' ').trim().replace(/[?.!]+$/g, '');
  const topic = (raw || '이 주제').slice(0, 36);
  return [
    `${topic}를 단계별 실행 체크리스트로 정리해줘.`,
    `${topic}에서 우선순위 높은 작업 5가지만 뽑아줘.`,
    `${topic} 진행 중 자주 막히는 지점과 해결법 알려줘.`,
  ];
}

function normalizeFollowUpQuestions(rawQuestions, userQuery) {
  const userNorm = normalizeForCompare(userQuery);
  const seen = new Set();
  const out = [];

  (Array.isArray(rawQuestions) ? rawQuestions : [])
    .map((item) => toStringSafe(item).replace(/\s+/g, ' ').trim())
    .forEach((q) => {
      if (!q) return;
      const normalized = normalizeForCompare(q);
      if (!normalized || normalized === userNorm || seen.has(normalized)) return;
      seen.add(normalized);
      out.push(q);
    });

  return out.slice(0, 3);
}

async function callGlmJson(
  messages,
  {
    model = ORCHESTRATOR_MODEL,
    timeoutMs = 9000,
    maxTokens = 220,
    temperature = 0.2,
    disableThinking = false,
  } = {},
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
        ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
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
  {
    model = ORCHESTRATOR_MODEL,
    timeoutMs = 7000,
    maxTokens = 120,
    temperature = 0.3,
    disableThinking = false,
  } = {},
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
        ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GLM4 API error: ${res.status} - ${body}`);
    }

    const payload = await res.json();
    const message = payload.choices?.[0]?.message || {};
    const content = toStringSafe(message.content).trim();
    if (content) return content;
    return toStringSafe(message.reasoning_content).trim();
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
      return `웹검색 결과에서 출처 ${context.sourceCount || 0}개를 확보했고 ${toStringSafe(context.domainsText) || '핵심 도메인'}를 우선 검토하겠습니다.`;
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
    lines.push(`primary_result_count: ${toIntSafe(context.searchPlan.primaryResultCount, 0)}`);
    lines.push(`search_reason: ${toStringSafe(context.searchPlan.reason).slice(0, 200)}`);
    lines.push(`primary_queries: ${(context.searchPlan.primaryQueries || []).join(' | ').slice(0, 240)}`);
  }

  if (context.secondDecision) {
    lines.push(`needs_more: ${Boolean(context.secondDecision.needsMore)}`);
    lines.push(`additional_result_count: ${toIntSafe(context.secondDecision.additionalResultCount, 0)}`);
    lines.push(`decision_reason: ${toStringSafe(context.secondDecision.reason).slice(0, 200)}`);
  }

  if (typeof context.sourceCount === 'number') {
    lines.push(`source_count: ${context.sourceCount}`);
  }
  if (typeof context.maxResults === 'number') {
    lines.push(`max_results_per_query: ${context.maxResults}`);
  }
  if (context.domainsText) {
    lines.push(`top_domains: ${context.domainsText}`);
  }
  if (Array.isArray(context.previousLines) && context.previousLines.length > 0) {
    lines.push(`previous_lines: ${context.previousLines.slice(-4).join(' || ')}`);
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
        'Length target: about 28~55 Korean characters.',
        'Describe current 판단 and next action.',
        'Include at least one concrete detail from the context (query term, source count, max_results, or domain).',
        'Avoid repeating the same generic sentence across stages.',
        'Do not restate the same meaning as previous_lines.',
        'Do not invent numbers, domains, or facts that are not present in context.',
        'If a value is missing, avoid specific numeric claims.',
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
      disableThinking: true,
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

async function emitThinking(res, { stage, stageKey, userQuery, context, history, emittedKeys }) {
  const key = toStringSafe(stageKey) || toStringSafe(stage);
  if (key && emittedKeys instanceof Set && emittedKeys.has(key)) return;

  const text = await generateThinkingNarration({
    stage,
    userQuery,
    context: {
      ...context,
      previousLines: history || [],
    },
  });
  if (!text) return;
  if (isNearDuplicateText(text, history)) return;

  if (Array.isArray(history)) {
    history.push(text);
    if (history.length > 12) history.shift();
  }

  if (key && emittedKeys instanceof Set) {
    emittedKeys.add(key);
  }

  sendSSE(res, 'thinking_text', text);
}

async function searchWeb(query, maxResults = SEARCH_RESULT_LIMITS.followup.default) {
  const resolvedMaxResults = clampInt(
    maxResults,
    SEARCH_RESULT_LIMITS.primary.min,
    SEARCH_RESULT_LIMITS.followup.max,
  );

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: resolvedMaxResults,
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
      content: sanitizeSearchText(r.content || r.raw_content),
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
        '- primaryResultCount is per-query max_results for first-round retrieval.',
        '- preferred range for primaryResultCount: 3~8 for single, 3~6 for multi.',
        '',
        'Return JSON schema exactly:',
        '{"shouldSearch": boolean, "mode": "none"|"single"|"multi", "primaryQueries": string[], "primaryResultCount": number, "reason": string}',
      ].join('\n'),
    },
  ];

  try {
    const plan = await callGlmJson(plannerMessages, {
      model: ORCHESTRATOR_MODEL,
      maxTokens: 260,
      timeoutMs: 9000,
      disableThinking: true,
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

async function optimizeSearchQueries({ userQuery, queries, mode = 'primary', maxQueries = 3 }) {
  const fallback = normalizeQueryArray(queries, maxQueries);
  const qualityFallback = enforceOptimizedQueryQuality(fallback, userQuery, mode, maxQueries);
  if (!fallback.length || !GLM4_API_KEY) return qualityFallback;

  const messages = [
    {
      role: 'system',
      content: [
        'You rewrite user search queries for web retrieval quality.',
        'Return JSON only.',
        'Keep entity names, version numbers, and constraints.',
        'Use concise keyword-style phrases, not long sentences.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `User query: "${toStringSafe(userQuery).slice(0, 240)}"`,
        `Round mode: ${mode}`,
        `Max queries: ${maxQueries}`,
        `Candidate queries: ${fallback.join(' | ')}`,
        '',
        'Rules:',
        '- Keep same intent; improve precision and retrieval effectiveness.',
        '- Add key qualifiers only when they help (official docs, install, setup, latest version, etc.).',
        '- For Korean, rewrite polite request sentences into concise keyword-style search phrases.',
        '- Prefer core terms and constraints over full natural-language sentences.',
        '- Each query must be <= 90 chars.',
        '- Queries must be keyword-style; avoid polite request endings.',
        '- Do not return exactly the same sentence as user query.',
        '- Do not output markdown or explanation.',
        '',
        'Return JSON schema exactly:',
        '{"queries": string[]}',
      ].join('\n'),
    },
  ];

  try {
    const rewritten = await callGlmJson(messages, {
      model: ORCHESTRATOR_MODEL,
      maxTokens: 220,
      timeoutMs: 8000,
      disableThinking: true,
    });

    const optimized = enforceOptimizedQueryQuality(rewritten?.queries, userQuery, mode, maxQueries);
    return optimized.length > 0 ? optimized : qualityFallback;
  } catch (err) {
    console.error('Search query optimizer error:', err.message);
    return qualityFallback;
  }
}

function buildInitialTodoFallback(userQuery, searchPlan = {}) {
  const topic = (
    keywordizeQueryText(userQuery) ||
    toStringSafe(userQuery).replace(/\s+/g, ' ').trim() ||
    '현재 질문'
  )
    .slice(0, 56)
    .trim();

  if (searchPlan?.shouldSearch) {
    return [
      `선생님께서 ${topic} 관련 답변을 요청하고 있습니다.`,
      '답변을 위해 아래 순서로 진행하겠습니다.',
      '- 수업 전개 계획 작성',
      '- 각 파트별 최신 정보 검색',
      '- 자료를 바탕으로 수업 내용 작성',
      '우선 웹검색으로 최신 정보를 확인하겠습니다.',
    ].join('\n');
  }

  return [
    `선생님께서 ${topic} 관련 답변을 요청하고 있습니다.`,
    '답변을 위해 아래 순서로 진행하겠습니다.',
    '- 요청 의도와 수업 목적 정리',
    '- 핵심 개념별 전개 흐름 설계',
    '- 바로 활용 가능한 수업안 작성',
    '검색 없이 보유 지식을 바탕으로 답변을 준비하겠습니다.',
  ].join('\n');
}

async function generateInitialTodoIntro({ userQuery, searchPlan }) {
  const fallback = buildInitialTodoFallback(userQuery, searchPlan);
  if (!GLM4_API_KEY) return fallback;

  const messages = [
    {
      role: 'system',
      content: [
        'You write the first Thinking-panel message in Korean for teachers.',
        'Output exactly 5~6 lines, plain text only.',
        'Line 1: paraphrase the user request naturally (do not copy verbatim).',
        'Line 2: short lead-in sentence for execution plan.',
        'Line 3~5: TODO bullets, each starts with "- ".',
        'Last line: immediate next action.',
        'No markdown headings, no code block, no quotation marks.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `user_query: ${toStringSafe(userQuery).slice(0, 280)}`,
        `should_search: ${Boolean(searchPlan?.shouldSearch)}`,
        `search_mode: ${toStringSafe(searchPlan?.mode) || 'none'}`,
        `optimized_queries: ${(searchPlan?.primaryQueries || []).join(' | ').slice(0, 220)}`,
        '',
        'If should_search=true, the last line must mention starting web search first.',
        'If should_search=false, the last line must mention proceeding without search.',
      ].join('\n'),
    },
  ];

  try {
    const raw = await callGlmText(messages, {
      model: ORCHESTRATOR_MODEL,
      maxTokens: 220,
      timeoutMs: 8000,
      temperature: 0.25,
      disableThinking: true,
    });
    const normalized = toStringSafe(raw)
      .replace(/```[\s\S]*?```/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 7)
      .join('\n');

    if (!normalized) return fallback;
    if (!/^-\s/m.test(normalized)) return fallback;
    return normalized;
  } catch (err) {
    console.error('Initial todo intro generation error:', err.message);
    return fallback;
  }
}

async function generateFollowUpQuestions({ userQuery, answerText }) {
  const fallback = buildFollowUpFallback(userQuery);
  if (!GLM4_API_KEY) return fallback;

  const trimmedAnswer = toStringSafe(answerText).replace(/\s+/g, ' ').trim().slice(0, 900);
  const messages = [
    {
      role: 'system',
      content: [
        'You generate exactly 3 high-quality Korean follow-up questions.',
        'Return JSON only.',
        'Questions must be actionable and non-duplicative.',
        'Do not repeat the user query wording.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `User query: "${toStringSafe(userQuery).slice(0, 240)}"`,
        `Assistant answer summary: "${trimmedAnswer || '(empty)'}"`,
        '',
        'Rules:',
        '- Output 3 concise Korean questions.',
        '- Avoid asking exactly same as the original user query.',
        '- Each question should be one sentence, <= 60 chars if possible.',
        '- No numbering, no markdown.',
        '',
        'Return JSON schema exactly:',
        '{"questions": string[]}',
      ].join('\n'),
    },
  ];

  try {
    const parsed = await callGlmJson(messages, {
      model: ORCHESTRATOR_MODEL,
      maxTokens: 160,
      timeoutMs: 4500,
      temperature: 0.35,
      disableThinking: true,
    });

    const normalized = normalizeFollowUpQuestions(parsed?.questions, userQuery);
    return normalized.length > 0 ? normalized : fallback;
  } catch (err) {
    console.error('Follow-up generation error:', err.message);
    return fallback;
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
        '{"needsMore": boolean, "refinedQueries": string[], "additionalResultCount": number, "reason": string}',
        'If needsMore=false, refinedQueries must be empty.',
        'If needsMore=true, provide 1-2 concise refined queries.',
        'If needsMore=true, additionalResultCount should usually be 8~12.',
      ].join('\n'),
    },
  ];

  try {
    const decision = await callGlmJson(messages, {
      model: ORCHESTRATOR_MODEL,
      maxTokens: 220,
      timeoutMs: 9000,
      disableThinking: true,
    });
    return normalizeSecondSearchDecision(decision);
  } catch (err) {
    console.error('Second search decision error:', err.message);
    return SECOND_SEARCH_FALLBACK;
  }
}

async function runSearchBatch({ queries, round, res, maxResults }) {
  const normalized = [...new Set((queries || []).map((q) => toStringSafe(q).trim()).filter(Boolean))];
  if (!normalized.length) return [];

  const settled = await Promise.allSettled(
    normalized.map(async (query) => {
      const data = await searchWeb(query, maxResults);
      return {
        round,
        query,
        maxResults,
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

function summarizeTopDomains(entries, max = 3) {
  const domains = [];
  for (const entry of entries || []) {
    for (const result of entry.results || []) {
      try {
        const u = new URL(result.url);
        if (!domains.includes(u.hostname)) domains.push(u.hostname);
      } catch {
        // ignore invalid url
      }
      if (domains.length >= max) break;
    }
    if (domains.length >= max) break;
  }
  return domains.join(', ');
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
        'Do not include inline source labels, URL lists, or a "출처" section in the answer body.',
        'The client app will render one consolidated source list at the end.',
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

    const thinkingHistory = [];
    const emittedThinkingKeys = new Set();
    const emit = (payload) =>
      emitThinking(res, {
        ...payload,
        history: thinkingHistory,
        emittedKeys: emittedThinkingKeys,
      });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    res.write(': connected\n\n');

    sendSSE(res, 'status', 'analyze_intent');
    await emit({
      stage: 'analyze_intent',
      userQuery: lastMessage.content,
    });

    sendSSE(res, 'status', 'decide_search');
    let searchPlan = await buildInitialSearchPlan(lastMessage.content, messages);
    if (searchPlan.shouldSearch && searchPlan.primaryQueries.length > 0) {
      const optimizedPrimaryQueries = await optimizeSearchQueries({
        userQuery: lastMessage.content,
        queries: searchPlan.primaryQueries,
        mode: 'primary',
        maxQueries: searchPlan.mode === 'multi' ? 3 : 1,
      });
      if (optimizedPrimaryQueries.length > 0) {
        searchPlan = { ...searchPlan, primaryQueries: optimizedPrimaryQueries };
      }
    }

    const initialTodoIntro = await generateInitialTodoIntro({
      userQuery: lastMessage.content,
      searchPlan,
    });
    if (initialTodoIntro) {
      sendSSE(res, 'thinking_intro', initialTodoIntro);
    }

    sendSSE(res, 'search_plan', searchPlan);
    await emit({
      stage: 'decide_search',
      userQuery: lastMessage.content,
      context: { searchPlan, maxResults: searchPlan.primaryResultCount },
    });

    sendSSE(res, 'status', 'plan_queries');

    let allSearchEntries = [];

    if (searchPlan.shouldSearch && TAVILY_API_KEY) {
      sendSSE(res, 'status', 'searching');
      await emit({
        stage: 'searching',
        userQuery: lastMessage.content,
        context: { searchPlan, maxResults: searchPlan.primaryResultCount },
      });

      const firstRoundEntries = await runSearchBatch({
        queries: searchPlan.primaryQueries,
        round: 1,
        res,
        maxResults: searchPlan.primaryResultCount,
      });

      allSearchEntries = [...firstRoundEntries];
      await emit({
        stage: 'search_results',
        stageKey: 'search_results_round_1',
        userQuery: lastMessage.content,
        context: {
          round: 1,
          sourceCount: firstRoundEntries.reduce((acc, item) => acc + item.results.length, 0),
          maxResults: searchPlan.primaryResultCount,
          domainsText: summarizeTopDomains(firstRoundEntries, 4),
        },
      });

      if (firstRoundEntries.length > 0) {
        sendSSE(res, 'status', 'analyzing');
        await emit({
          stage: 'analyzing',
          userQuery: lastMessage.content,
          context: { searchPlan },
        });
        let secondDecision = await shouldDoSecondSearch(
          lastMessage.content,
          searchPlan,
          firstRoundEntries,
        );
        if (secondDecision.needsMore && secondDecision.refinedQueries.length > 0) {
          const optimizedRefinedQueries = await optimizeSearchQueries({
            userQuery: lastMessage.content,
            queries: secondDecision.refinedQueries,
            mode: 'followup',
            maxQueries: 2,
          });
          if (optimizedRefinedQueries.length > 0) {
            secondDecision = { ...secondDecision, refinedQueries: optimizedRefinedQueries };
          }
        }
        sendSSE(res, 'search_decision', secondDecision);
        await emit({
          stage: 'analyzing',
          userQuery: lastMessage.content,
          context: {
            searchPlan,
            secondDecision,
            maxResults: secondDecision.additionalResultCount,
          },
        });

        if (secondDecision.needsMore) {
          sendSSE(res, 'status', 'searching_2');
          await emit({
            stage: 'searching_2',
            userQuery: lastMessage.content,
            context: { secondDecision, maxResults: secondDecision.additionalResultCount },
          });
          const secondRoundEntries = await runSearchBatch({
            queries: secondDecision.refinedQueries,
            round: 2,
            res,
            maxResults: secondDecision.additionalResultCount,
          });
          allSearchEntries = [...allSearchEntries, ...secondRoundEntries];
          await emit({
            stage: 'search_results',
            stageKey: 'search_results_round_2',
            userQuery: lastMessage.content,
            context: {
              round: 2,
              sourceCount: secondRoundEntries.reduce((acc, item) => acc + item.results.length, 0),
              maxResults: secondDecision.additionalResultCount,
              domainsText: summarizeTopDomains(secondRoundEntries, 4),
            },
          });
        }
      } else {
        sendSSE(res, 'status', 'search_failed');
        await emit({
          stage: 'error',
          userQuery: lastMessage.content,
          context: { error: '1차 검색 결과를 확보하지 못했습니다.' },
        });
      }
    } else {
      sendSSE(res, 'status', 'search_skipped');
      await emit({
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
        await emit({
          stage: 'error',
          userQuery: lastMessage.content,
          context: { error: 'TAVILY_API_KEY is missing. Search is skipped.' },
        });
      }
    }

    sendSSE(res, 'status', 'synthesize');
    await emit({
      stage: 'synthesize',
      userQuery: lastMessage.content,
      context: { searchPlan },
    });

    const finalMessages = buildFinalMessages(messages, allSearchEntries);

    sendSSE(res, 'status', 'thinking');
    await emit({
      stage: 'thinking',
      userQuery: lastMessage.content,
      context: { searchPlan },
    });
    const glmRes = await chatWithGlmStream(finalMessages);

    sendSSE(res, 'status', 'streaming');
    const reader = glmRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let generatedAnswerText = '';

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
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            generatedAnswerText += content;
            sendSSE(res, 'content', content);
          }
        } catch {
          // ignore malformed stream line
        }
      }
    }

    const followUps = await generateFollowUpQuestions({
      userQuery: lastMessage.content,
      answerText: generatedAnswerText,
    });
    if (followUps.length > 0) {
      sendSSE(res, 'follow_ups', followUps);
    }

    res.write('data: [DONE]\n\n');

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
    const { query, maxResults } = req.body || {};
    if (!toStringSafe(query).trim()) {
      return res.status(400).json({ error: 'query is required' });
    }

    if (!TAVILY_API_KEY) {
      return res.status(500).json({ error: 'TAVILY_API_KEY is missing' });
    }

    const data = await searchWeb(query, maxResults);
    res.json(data);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


