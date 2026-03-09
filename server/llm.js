/**
 * Multi-provider LLM utility — supports OpenAI, Gemini, GLM (Zhipu AI).
 * Provides both non-streaming (generate) and streaming (stream) interfaces.
 */
import dotenv from 'dotenv';
dotenv.config();

const {
  OPENAI_API_KEY = '',
  OPENAI_BASE_URL = 'https://api.openai.com/v1',
  GEMINI_API_KEY = '',
  GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta',
  GLM_API_KEY = '',
  GLM4_API_KEY = '',
  GLM_BASE_URL = '',
  GLM4_BASE_URL = '',
} = process.env;

const RESOLVED_GLM_API_KEY = GLM_API_KEY || GLM4_API_KEY || '';
const RESOLVED_GLM_BASE_URL = GLM_BASE_URL || GLM4_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';

// ── Provider detection ──────────────────────────────────────────────────────
function detectProvider(model) {
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('glm-')) return 'glm';
  // fallback: try openai if key exists, then gemini, then glm
  if (OPENAI_API_KEY) return 'openai';
  if (GEMINI_API_KEY) return 'gemini';
  return 'glm';
}

// ── Gemini ───────────────────────────────────────────────────────────────────
async function geminiGenerate(model, messages, { system, temperature = 0.7, maxTokens = 4096, jsonMode = false } = {}) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const url = `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function* geminiStream(model, messages, { system, temperature = 0.7, maxTokens = 4096 } = {}) {
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const url = `${GEMINI_BASE_URL}/models/${model}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Gemini stream ${res.status}: ${err.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
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
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text;
      } catch { /* skip */ }
    }
  }
}

// ── OpenAI / GLM (compatible API) ────────────────────────────────────────────
// Reasoning models: no custom temperature, need extra tokens for chain-of-thought
const REASONING_MODELS = new Set(['gpt-5-nano', 'o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o4-mini']);
const MIN_REASONING_TOKENS = 2000; // reasoning models use ~200-800 tokens for thinking

function isReasoningModel(model) {
  return REASONING_MODELS.has(model);
}

function supportsTemperature(model) {
  return !isReasoningModel(model);
}

function adjustTokensForReasoning(model, maxTokens) {
  if (isReasoningModel(model) && maxTokens < MIN_REASONING_TOKENS) {
    return MIN_REASONING_TOKENS;
  }
  return maxTokens;
}

async function openaiGenerate(model, messages, { system, temperature = 0.7, maxTokens = 4096, jsonMode = false, provider = 'openai' } = {}) {
  const apiKey = provider === 'glm' ? RESOLVED_GLM_API_KEY : OPENAI_API_KEY;
  const baseUrl = provider === 'glm' ? RESOLVED_GLM_BASE_URL : OPENAI_BASE_URL;

  const allMessages = [];
  if (system) allMessages.push({ role: 'system', content: system });
  allMessages.push(...messages);

  const body = { model, messages: allMessages, max_completion_tokens: adjustTokensForReasoning(model, maxTokens), stream: false };
  if (supportsTemperature(model)) body.temperature = temperature;
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`${provider} ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function* openaiStream(model, messages, { system, temperature = 0.7, maxTokens = 4096, provider = 'openai' } = {}) {
  const apiKey = provider === 'glm' ? RESOLVED_GLM_API_KEY : OPENAI_API_KEY;
  const baseUrl = provider === 'glm' ? RESOLVED_GLM_BASE_URL : OPENAI_BASE_URL;

  const allMessages = [];
  if (system) allMessages.push({ role: 'system', content: system });
  allMessages.push(...messages);

  const body = { model, messages: allMessages, max_completion_tokens: adjustTokensForReasoning(model, maxTokens), stream: true };
  if (supportsTemperature(model)) body.temperature = temperature;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`${provider} stream ${res.status}: ${err.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
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
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* skip */ }
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate text (non-streaming).
 * @param {string} model - Model ID (e.g. "gpt-5-nano", "gemini-3-flash-preview")
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options - { system, temperature, maxTokens, jsonMode }
 * @returns {Promise<string>}
 */
export async function generate(model, messages, options = {}) {
  const provider = detectProvider(model);
  if (provider === 'gemini') return geminiGenerate(model, messages, options);
  return openaiGenerate(model, messages, { ...options, provider });
}

/**
 * Generate JSON object (non-streaming).
 */
export async function generateJSON(model, messages, options = {}) {
  const text = await generate(model, messages, { ...options, jsonMode: true });
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON from text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Failed to parse JSON from LLM response');
  }
}

/**
 * Stream text generation.
 * @returns {AsyncGenerator<string>}
 */
export async function* stream(model, messages, options = {}) {
  const provider = detectProvider(model);
  if (provider === 'gemini') yield* geminiStream(model, messages, options);
  else yield* openaiStream(model, messages, { ...options, provider });
}

export { detectProvider };
