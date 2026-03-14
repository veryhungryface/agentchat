// Dynamic imports to avoid Playwright dependency at module load time.
// This allows the module to work in serverless environments (Vercel)
// where Playwright is not available.

const AGENT_LOADERS = {
  research: () => import('./specialized/research.js').then((m) => m.runResearchAgent),
  coding: () => import('./specialized/coding.js').then((m) => m.runCodingAgent),
  math: () => import('./specialized/math.js').then((m) => m.runMathAgent),
  creative: () => import('./specialized/creative.js').then((m) => m.runCreativeAgent),
  general: () => import('./specialized/general.js').then((m) => m.runGeneralAgent),
  browser: () => import('./specialized/browser.js').then((m) => m.runBrowserAgent),
  interactive: () => import('./specialized/interactive.js').then((m) => m.runInteractiveAgent),
};

const AGENT_LABELS = {
  research: '리서치 에이전트',
  coding: '코딩 에이전트',
  math: '수학 에이전트',
  creative: '크리에이티브 에이전트',
  general: '일반 에이전트',
  browser: '브라우저 에이전트',
  interactive: '인터랙티브 에이전트',
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
      const loader = AGENT_LOADERS[agentType];
      if (!loader) {
        onAgentComplete?.(label, false, agentType);
        return { agentName: label, result: '', success: false, error: `Unknown agent: ${agentType}` };
      }

      try {
        const fn = await loader();
        const needsScreenshot = agentType === 'research' || agentType === 'browser';
        const result = await fn(messages, model, needsScreenshot ? onScreenshot : undefined);
        onAgentComplete?.(label, true, agentType);
        return { agentName: label, result, success: true };
      } catch (err) {
        console.error(`[dispatcher] ${label} error:`, err.message, err.stack?.split('\n').slice(0, 3).join('\n'));
        onAgentComplete?.(label, false, agentType);
        return { agentName: label, result: '', success: false, error: err.message };
      }
    }),
  );

  return results;
}

export { AGENT_LABELS };
