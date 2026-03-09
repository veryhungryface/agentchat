import { runResearchAgent } from './specialized/research.js';
import { runCodingAgent } from './specialized/coding.js';
import { runMathAgent } from './specialized/math.js';
import { runCreativeAgent } from './specialized/creative.js';
import { runGeneralAgent } from './specialized/general.js';
import { runBrowserAgent } from './specialized/browser.js';

const AGENT_MAP = {
  research: runResearchAgent,
  coding: runCodingAgent,
  math: runMathAgent,
  creative: runCreativeAgent,
  general: runGeneralAgent,
  browser: runBrowserAgent,
};

const AGENT_LABELS = {
  research: '리서치 에이전트',
  coding: '코딩 에이전트',
  math: '수학 에이전트',
  creative: '크리에이티브 에이전트',
  general: '일반 에이전트',
  browser: '브라우저 에이전트',
};

/**
 * Dispatch multiple agents in parallel.
 * @param {string[]} agents - Agent types to run
 * @param {Array} messages - Conversation history
 * @param {string} mainModel - Model for specialized agents
 * @param {string} fastModel - Model for general agent
 * @param {object} callbacks - { onAgentStart, onAgentComplete, onScreenshot }
 * @returns {Promise<Array<{ agentName, result, success, error? }>>}
 */
export async function dispatchAgents(agents, messages, mainModel, fastModel, callbacks = {}) {
  const { onAgentStart, onAgentComplete, onScreenshot } = callbacks;

  const results = await Promise.all(
    agents.map(async (agentType) => {
      const label = AGENT_LABELS[agentType] || agentType;
      onAgentStart?.(label, agentType);

      const model = agentType === 'general' ? fastModel : mainModel;
      const fn = AGENT_MAP[agentType];
      if (!fn) {
        return { agentName: label, result: '', success: false, error: `Unknown agent: ${agentType}` };
      }

      try {
        const needsScreenshot = agentType === 'research' || agentType === 'browser';
        const result = await fn(messages, model, needsScreenshot ? onScreenshot : undefined);
        onAgentComplete?.(label, true, agentType);
        return { agentName: label, result, success: true };
      } catch (err) {
        onAgentComplete?.(label, false, agentType);
        return { agentName: label, result: '', success: false, error: err.message };
      }
    }),
  );

  return results;
}

export { AGENT_LABELS };
