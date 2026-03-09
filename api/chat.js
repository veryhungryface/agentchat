/**
 * Vercel Serverless Function — /api/chat
 * 6-stage orchestration pipeline using Vercel AI SDK.
 * Produces the same SSE format as the Express server.
 */
import { screenQuery } from '../server/agents/screener.js';
import { classifyQuery } from '../server/agents/router.js';
import { dispatchAgents, AGENT_LABELS } from '../server/agents/dispatcher.js';
import { synthesizeResults } from '../server/agents/synthesizer.js';
import { generate } from '../server/llm.js';

export const config = { maxDuration: 60 };

const DEFAULT_MODEL = 'gemini-2.0-flash';

function sendSSE(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
}

async function generateFollowUps(answer, userQuery, model) {
  try {
    const text = await generate(model, [
      { role: 'user', content: userQuery },
      { role: 'assistant', content: answer.slice(0, 1500) },
      { role: 'user', content: '위 답변을 바탕으로 사용자가 이어서 물어볼 만한 후속 질문 3개를 JSON 배열 형태로만 응답해주세요. 예: ["질문1", "질문2", "질문3"]' },
    ], { temperature: 0.6, maxTokens: 600 });

    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]);
      return arr.filter((q) => typeof q === 'string' && q.trim()).slice(0, 3);
    }
  } catch { /* skip */ }
  return [];
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { messages = [], model: selectedModel } = req.body || {};
  const mainModel = selectedModel || DEFAULT_MODEL;
  const fastModel = DEFAULT_MODEL;

  const apiMessages = messages.map((m) => ({
    role: m.role || 'user',
    content: m.content || '',
  }));

  const lastUserMsg = [...apiMessages].reverse().find((m) => m.role === 'user')?.content || '';

  try {
    // ── Stage 1: Screening ──────────────────────────────────────────────────
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

    // ── Stage 2: Routing ────────────────────────────────────────────────────
    sendSSE(res, 'status', 'routing');
    sendSSE(res, 'thinking_update', { stage: 'routing', text: '에이전트 선택 중...' });
    const routing = await classifyQuery(lastUserMsg, fastModel);

    const agentList = routing.suggestedAgents;
    const agentLabels = agentList.map((a) => AGENT_LABELS[a] || a);
    sendSSE(res, 'routing_result', {
      agents: agentList,
      labels: agentLabels,
      reasoning: routing.reasoning,
    });
    const hasSearch = agentList.includes('research') || agentList.includes('browser');
    sendSSE(res, 'thinking_update', { stage: 'routing', text: `${agentLabels.join(', ')} 선택됨 ✓` });

    if (!hasSearch) {
      sendSSE(res, 'status', 'search_skipped');
    }

    // ── Stage 3: Parallel Agent Execution ───────────────────────────────────
    sendSSE(res, 'status', 'executing');
    const agentResults = await dispatchAgents(agentList, apiMessages, mainModel, fastModel, {
      onAgentStart: (label, type) => {
        sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${label} 실행 중...` });
        if (type === 'research' || type === 'browser') {
          sendSSE(res, 'status', 'searching');
        }
      },
      onAgentComplete: (label, success) => {
        sendSSE(res, 'thinking_update', {
          stage: 'agent_exec',
          text: success ? `${label} 완료 ✓` : `${label} 실패 ✗`,
        });
      },
    });

    // Attach search results (if research agent produced URLs)
    const researchResult = agentResults.find((r) => r.agentName === AGENT_LABELS.research);
    if (researchResult?.success && researchResult.result) {
      const urlMatches = researchResult.result.match(/https?:\/\/[^\s)]+/g) || [];
      const sources = urlMatches.slice(0, 5).map((url) => ({ url, title: url }));
      if (sources.length > 0) {
        sendSSE(res, 'search', { query: lastUserMsg, results: sources, round: 1 });
      }
    }

    // ── Stage 4-5: Synthesis + Streaming ────────────────────────────────────
    sendSSE(res, 'status', 'synthesize');
    sendSSE(res, 'thinking_update', { stage: 'synthesize', text: '결과 종합 중...' });

    sendSSE(res, 'status', 'streaming');
    let fullAnswer = '';
    let followUpPromise = null;
    for await (const chunk of synthesizeResults(agentResults, apiMessages, mainModel)) {
      fullAnswer += chunk;
      sendSSE(res, 'content', chunk);
      if (!followUpPromise && fullAnswer.length > 200) {
        followUpPromise = generateFollowUps(fullAnswer, lastUserMsg, fastModel);
      }
    }

    if (!followUpPromise) {
      followUpPromise = generateFollowUps(fullAnswer, lastUserMsg, fastModel);
    }

    const followUps = await followUpPromise;
    if (followUps.length > 0) {
      sendSSE(res, 'follow_ups', followUps);
    }

    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[api/chat] Error:', err);
    sendSSE(res, 'content', `오류가 발생했습니다: ${err.message}`);
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}
