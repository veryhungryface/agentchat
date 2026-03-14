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
    const errors = agentResults
      .filter((r) => !r.success)
      .map((r) => `${r.agentName}: ${r.error || 'unknown'}`)
      .join('\n');
    console.error('[synthesizer] All agents failed:\n', errors);
    yield `죄송합니다. 요청을 처리하는 중 오류가 발생했습니다.\n\n오류 상세: ${errors}`;
    return;
  }

  // Interactive agent: always pass through the HTML separately
  const interactiveResult = successfulResults.find((r) =>
    r.agentName === '인터랙티브 에이전트' || r.agentName?.includes('인터랙티브'));
  if (interactiveResult) {
    // Remove interactive result from synthesis — it will be sent as interactive_html
    const textResults = successfulResults.filter((r) => r !== interactiveResult);
    if (textResults.length > 0) {
      // Synthesize text explanation from other agents, then append interactive HTML
      const agentContext = textResults.map((r) => r.result).join('\n\n---\n\n');
      yield* llmStream(model, messages, {
        system: `You are a helpful AI assistant. Below is reference information:

<reference>
${agentContext}
</reference>

Present the information naturally as a brief introduction/explanation. Keep it SHORT (2-4 sentences max).
Do NOT mention agents or internal processing. Do NOT include URLs or source sections.
Respond in the same language as the user.`,
        temperature: 0.7,
        maxTokens: 512,
      });
    }
    // Split interactive result: code fence → interactive_html, trailing text → content
    const interactiveRaw = interactiveResult.result || '';
    const fenceMatch = interactiveRaw.match(/```html\s*\n([\s\S]*?)```/);
    if (fenceMatch) {
      const htmlCode = fenceMatch[1].trim();
      const afterFence = interactiveRaw.slice(interactiveRaw.indexOf('```', fenceMatch.index + 3) + 3).trim();
      yield { __interactive: true, content: htmlCode };
      if (afterFence) {
        yield '\n\n' + afterFence;
      }
    } else {
      yield { __interactive: true, content: interactiveRaw };
    }
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
Use inline code (\`like this\`) for short terms/names, NOT fenced code blocks. Only use fenced code blocks for multi-line code.
Respond directly and concisely in the same language as the user.`
    : `You are a helpful AI assistant. Below are reference materials from multiple sources:

${successfulResults.map((r, i) => `<source${i + 1}>\n${r.result}\n</source${i + 1}>`).join('\n\n')}

Combine these into one coherent, well-structured response.
Do NOT mention sources, agents, or internal processing.
Do NOT use meta-commentary like "[결과]", "[분석]", "[답변 구성]" etc.
IMPORTANT: Do NOT include any URLs, links, or "출처"/"참고"/"References" sections in your response. Source citations are handled separately by the system.
Use inline code (\`like this\`) for short terms/names, NOT fenced code blocks. Only use fenced code blocks for multi-line code.
Respond directly in the same language as the user. Use markdown formatting where appropriate.`;

  yield* llmStream(model, messages, {
    system,
    temperature: 0.7,
    maxTokens: 2048,
  });
}
