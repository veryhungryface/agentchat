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

const DEFAULT_MODEL = 'gemini-2.0-flash';

function getModel(name) {
  if (name?.startsWith('gemini')) return google?.(name) ?? google?.(DEFAULT_MODEL);
  if (name?.startsWith('gpt') || name?.startsWith('o1') || name?.startsWith('o3') || name?.startsWith('o4')) {
    return openai?.(name);
  }
  return google?.(name ?? DEFAULT_MODEL) ?? openai?.(name ?? 'gpt-4o');
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
  "category": "general"|"research"|"coding"|"math"|"creative",
  "suggestedAgents": ["agent1"],
  "reasoning": "why"
}
Available agents: "general", "research", "coding", "math", "creative".
Rules:
- Factual/current events → "research"
- Code/debugging → "coding"
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
    return { suggestedAgents: agents, reasoning: parsed.reasoning || '' };
  } catch {
    return { suggestedAgents: ['general'], reasoning: 'Classification failed, using general' };
  }
}

// ── Stage 3: Agent execution ────────────────────────────────────────────────
const AGENT_LABELS = {
  research: '리서치 에이전트',
  coding: '코딩 에이전트',
  math: '수학 에이전트',
  creative: '크리에이티브 에이전트',
  general: '일반 에이전트',
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
};

async function runAgent(agentType, messages, model) {
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
    const agentResults = await Promise.all(
      agentList.map(async (agentType) => {
        const label = AGENT_LABELS[agentType];
        sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${label} 실행 중...` });
        try {
          const result = await runAgent(agentType, apiMessages, agentType === 'general' ? fastModel : mainModel);
          sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${label} 완료 ✓` });
          return { agentName: label, result, success: true };
        } catch (err) {
          console.error(`[api/chat] ${label} error:`, err.message);
          sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: `${label} 실패: ${err.message.slice(0, 80)}` });
          return { agentName: label, result: '', success: false, error: err.message };
        }
      }),
    );

    // ── Fallback: if all agents failed, try general directly ─────────
    let successfulResults = agentResults.filter((r) => r.success && r.result);
    if (successfulResults.length === 0) {
      const errors = agentResults.map((r) => `${r.agentName}: ${r.error}`).join(', ');
      console.error('[api/chat] All agents failed:', errors);
      sendSSE(res, 'thinking_update', { stage: 'agent_exec', text: '에이전트 실패 — 일반 모드로 재시도 중...' });
      try {
        const result = await runAgent('general', apiMessages, fastModel);
        agentResults.push({ agentName: '일반 에이전트 (폴백)', result, success: true });
        successfulResults = agentResults.filter((r) => r.success && r.result);
      } catch (fallbackErr) {
        sendSSE(res, 'content', `오류가 발생했습니다: ${errors}`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
    }

    sendSSE(res, 'status', 'synthesize');
    sendSSE(res, 'thinking_update', { stage: 'synthesize', text: '결과 종합 중...' });

    sendSSE(res, 'status', 'streaming');
    const system = buildSynthesisSystem(successfulResults);

    let fullAnswer = '';
    let followUpPromise = null;

    const result = streamText({
      model: getModel(mainModel),
      system,
      messages: apiMessages,
      temperature: 0.7,
      maxTokens: 2048,
    });

    for await (const chunk of result.textStream) {
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
