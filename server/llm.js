/**
 * Multi-provider LLM utility — powered by Vercel AI SDK.
 * Supports OpenAI, Gemini, GLM (Zhipu AI).
 */
import dotenv from 'dotenv';
import { generateText, streamText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

dotenv.config();

// ── Provider setup ───────────────────────────────────────────────────────────
const googleProvider = process.env.GEMINI_API_KEY
  ? createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const openaiProvider = process.env.OPENAI_API_KEY
  ? createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    })
  : null;

function getGlmProvider() {
  const apiKey = process.env.GLM_API_KEY || process.env.GLM4_API_KEY;
  const baseURL = process.env.GLM_BASE_URL || process.env.GLM4_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  if (!apiKey) return null;
  return createOpenAI({ apiKey, baseURL, compatibility: 'compatible' });
}

// ── Provider detection ───────────────────────────────────────────────────────
function detectProvider(model) {
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('glm-')) return 'glm';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'glm';
}

// ── Reasoning model handling ─────────────────────────────────────────────────
const REASONING_MODELS = new Set(['o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o4-mini']);
const MIN_REASONING_TOKENS = 2000;

function isReasoningModel(model) {
  return REASONING_MODELS.has(model);
}

// ── Get AI SDK model instance ────────────────────────────────────────────────
function getModel(modelName) {
  const provider = detectProvider(modelName);
  switch (provider) {
    case 'gemini':
      if (!googleProvider) throw new Error('GEMINI_API_KEY not configured');
      return googleProvider(modelName);
    case 'openai':
      if (!openaiProvider) throw new Error('OPENAI_API_KEY not configured');
      return openaiProvider(modelName);
    case 'glm': {
      const glm = getGlmProvider();
      if (!glm) throw new Error('GLM_API_KEY not configured');
      return glm(modelName);
    }
    default:
      if (googleProvider) return googleProvider(modelName);
      if (openaiProvider) return openaiProvider(modelName);
      throw new Error('No LLM API key configured');
  }
}

// ── Build params with reasoning model adjustments ────────────────────────────
function buildParams(model, messages, options = {}) {
  const { system, temperature = 0.7, maxTokens = 4096 } = options;
  const reasoning = isReasoningModel(model);

  const params = {
    model: getModel(model),
    system,
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || '',
    })),
    maxTokens: reasoning ? Math.max(MIN_REASONING_TOKENS, maxTokens) : maxTokens,
  };

  if (!reasoning) {
    params.temperature = temperature;
  }

  return params;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate text (non-streaming).
 * @param {string} model - Model ID (e.g. "gpt-5-nano", "gemini-3-flash-preview")
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options - { system, temperature, maxTokens }
 * @returns {Promise<string>}
 */
export async function generate(model, messages, options = {}) {
  const result = await generateText(buildParams(model, messages, options));
  return result.text;
}

/**
 * Generate JSON object (non-streaming).
 */
export async function generateJSON(model, messages, options = {}) {
  const text = await generate(model, messages, options);
  try {
    return JSON.parse(text);
  } catch {
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
  const result = streamText(buildParams(model, messages, options));
  for await (const chunk of result.textStream) {
    yield chunk;
  }
}

export { detectProvider };
