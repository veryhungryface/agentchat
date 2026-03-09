import { stream as llmStream } from '../llm.js';

/**
 * Synthesize agent results into a final streaming response.
 * @param {Array} agentResults - [{ agentName, result, success }]
 * @param {Array} messages - Conversation history
 * @param {string} model - Model to use for synthesis
 * @returns {AsyncGenerator<string>} - Streaming text tokens
 */
export async function* synthesizeResults(agentResults, messages, model) {
  const successfulResults = agentResults.filter((r) => r.success && r.result);

  if (successfulResults.length === 0) {
    yield '죄송합니다. 요청을 처리하는 중 오류가 발생했습니다. 다시 시도해 주세요.';
    return;
  }

  const singleAgent = successfulResults.length === 1;
  const agentContext = successfulResults
    .map((r) => r.result)
    .join('\n\n---\n\n');

  const system = singleAgent
    ? `You are a helpful AI assistant. Below is reference information to help you answer:

<reference>
${agentContext}
</reference>

Present the information naturally as your own response. Do NOT mention any agents, analysis steps, or internal processing.
Do NOT use meta-commentary like "[결과]", "[분석]", "[답변 구성]" etc.
IMPORTANT: Do NOT include any URLs, links, or "출처"/"참고"/"References" sections in your response. Source citations are handled separately by the system.
Respond directly and concisely in the same language as the user.`
    : `You are a helpful AI assistant. Below are reference materials from multiple sources:

${successfulResults.map((r, i) => `<source${i + 1}>\n${r.result}\n</source${i + 1}>`).join('\n\n')}

Combine these into one coherent, well-structured response.
Do NOT mention sources, agents, or internal processing.
Do NOT use meta-commentary like "[결과]", "[분석]", "[답변 구성]" etc.
IMPORTANT: Do NOT include any URLs, links, or "출처"/"참고"/"References" sections in your response. Source citations are handled separately by the system.
Respond directly in the same language as the user. Use markdown formatting where appropriate.`;

  yield* llmStream(model, messages, {
    system,
    temperature: 0.7,
    maxTokens: 2048,
  });
}
