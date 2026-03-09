/* global process */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { screenQuery } from './server/agents/screener.js';
import { classifyQuery } from './server/agents/router.js';
import { dispatchAgents, AGENT_LABELS } from './server/agents/dispatcher.js';
import { synthesizeResults } from './server/agents/synthesizer.js';
import { generate } from './server/llm.js';

dotenv.config();

const {
  FRONTEND_ORIGIN = '',
  CORS_ALLOWED_ORIGINS = '',
  PORT = 3001,
} = process.env;

// ── CORS ─────────────────────────────────────────────────────────────────────
function parseAllowedOrigins(...rawValues) {
  return [...new Set(
    rawValues
      .flatMap((v) => (typeof v === 'string' ? v : '').split(','))
      .map((o) => o.trim())
      .filter(Boolean),
  )];
}

const ALLOWED_ORIGINS = parseAllowedOrigins(FRONTEND_ORIGIN, CORS_ALLOWED_ORIGINS);
const HAS_CORS_ALLOWLIST = ALLOWED_ORIGINS.length > 0;

const app = express();
app.use(cors({
  origin(origin, cb) {
    if (!origin || !HAS_CORS_ALLOWLIST || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options(/.*/, cors());
app.use(express.json());

// ── SSE helper ───────────────────────────────────────────────────────────────
function sendSSE(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
}

// ── Model defaults ───────────────────────────────────────────────────────────
const DEFAULT_MAIN_MODEL = 'gemini-3-flash-preview';
const DEFAULT_FAST_MODEL = 'gpt-5-nano';

// ── Follow-up generation ─────────────────────────────────────────────────────
async function generateFollowUps(answer, userQuery, model) {
  try {
    const text = await generate(model, [
      { role: 'user', content: userQuery },
      { role: 'assistant', content: answer.slice(0, 1500) },
      { role: 'user', content: '위 답변을 바탕으로 사용자가 이어서 물어볼 만한 후속 질문 3개를 JSON 배열 형태로만 응답해주세요. 예: ["질문1", "질문2", "질문3"]' },
    ], { temperature: 0.6, maxTokens: 300 });

    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      return arr.filter((q) => typeof q === 'string' && q.trim()).slice(0, 3);
    }
  } catch { /* skip */ }
  return [];
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/chat — 6-stage orchestration pipeline
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { messages = [], model: selectedModel } = req.body;
  const mainModel = selectedModel || DEFAULT_MAIN_MODEL;
  const fastModel = DEFAULT_FAST_MODEL;

  const apiMessages = messages.map((m) => ({
    role: m.role || 'user',
    content: m.content || '',
  }));

  const lastUserMsg = [...apiMessages].reverse().find((m) => m.role === 'user')?.content || '';
  const timer = (label) => {
    const start = Date.now();
    return () => console.log(`[pipeline] ${label}: ${Date.now() - start}ms`);
  };

  try {
    // ── Stage 1: Screening ────────────────────────────────────────────────────
    sendSSE(res, 'status', 'screening');
    sendSSE(res, 'thinking_update', { stage: 'screening', text: '안전성 검사 중...' });
    const t1 = timer('screening');
    const screening = await screenQuery(lastUserMsg, fastModel);
    t1();

    if (!screening.safe) {
      sendSSE(res, 'status', 'rejected');
      sendSSE(res, 'thinking_update', { stage: 'screening', text: `안전성 검사 불통과: ${screening.reason}` });
      sendSSE(res, 'content', '죄송합니다. 해당 요청은 처리할 수 없습니다.');
      sendSSE(res, 'status', 'streaming');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    sendSSE(res, 'thinking_update', { stage: 'screening', text: '안전성 검사 통과 ✓' });

    // ── Stage 2: Routing ──────────────────────────────────────────────────────
    sendSSE(res, 'status', 'routing');
    sendSSE(res, 'thinking_update', { stage: 'routing', text: '에이전트 선택 중...' });
    const t2 = timer('routing');
    const routing = await classifyQuery(lastUserMsg, fastModel);
    t2();

    const agentList = routing.suggestedAgents;
    const agentLabels = agentList.map((a) => AGENT_LABELS[a] || a);
    sendSSE(res, 'routing_result', {
      agents: agentList,
      labels: agentLabels,
      reasoning: routing.reasoning,
    });
    const hasSearch = agentList.includes('research');
    sendSSE(res, 'thinking_update', { stage: 'routing', text: `${agentLabels.join(', ')} 선택됨 ✓` });

    // If no search needed, skip search steps
    if (!hasSearch) {
      sendSSE(res, 'status', 'search_skipped');
    }

    // ── Stage 3: Parallel Agent Execution ─────────────────────────────────────
    sendSSE(res, 'status', 'executing');
    const t3 = timer('agents');

    const agentResults = await dispatchAgents(agentList, apiMessages, mainModel, fastModel, {
      onAgentStart: (label, type) => {
        sendSSE(res, 'thinking_update', { stage: `agent_${type}`, text: `${label} 실행 중...` });
        if (type === 'research') {
          sendSSE(res, 'status', 'searching');
        }
      },
      onAgentComplete: (label, success, type) => {
        sendSSE(res, 'thinking_update', { stage: `agent_${type}`, text: success ? `${label} 완료 ✓` : `${label} 실패 ✗` });
      },
      onScreenshot: (screenshot) => {
        sendSSE(res, 'browser_screenshot', screenshot);
      },
    });
    t3();

    // Attach search results to pipeline (if research agent ran)
    const researchResult = agentResults.find((r) => r.agentName === AGENT_LABELS.research);
    if (researchResult?.success && researchResult.result) {
      const urlMatches = researchResult.result.match(/https?:\/\/[^\s)]+/g) || [];
      const sources = urlMatches.slice(0, 5).map((url) => ({ url, title: url }));
      if (sources.length > 0) {
        sendSSE(res, 'search', {
          query: lastUserMsg,
          results: sources,
          round: 1,
        });
      }
    }

    // ── Stage 4-5: Synthesis + Streaming ──────────────────────────────────────
    sendSSE(res, 'status', 'synthesize');
    sendSSE(res, 'thinking_update', { stage: 'synthesize', text: '결과 종합 중...' });
    const t4 = timer('synthesis');

    sendSSE(res, 'status', 'streaming');
    let fullAnswer = '';
    for await (const chunk of synthesizeResults(agentResults, apiMessages, mainModel)) {
      fullAnswer += chunk;
      sendSSE(res, 'content', chunk);
    }
    t4();

    // ── Stage 6: Follow-up questions ──────────────────────────────────────────
    const followUps = await generateFollowUps(fullAnswer, lastUserMsg, fastModel);
    if (followUps.length > 0) {
      sendSSE(res, 'follow_ups', followUps);
    }

    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[pipeline] Error:', err);
    sendSSE(res, 'content', `오류가 발생했습니다: ${err.message}`);
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mainModel: DEFAULT_MAIN_MODEL,
    fastModel: DEFAULT_FAST_MODEL,
    features: ['orchestration', 'playwright-search', 'multi-agent'],
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Orchestration server running on port ${PORT}`);
  console.log(`[server] Main model: ${DEFAULT_MAIN_MODEL}`);
  console.log(`[server] Fast model: ${DEFAULT_FAST_MODEL}`);
});
