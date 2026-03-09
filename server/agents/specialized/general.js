import { generate } from '../../llm.js';

export async function runGeneralAgent(messages, model) {
  return generate(model, messages, {
    system: `You are a friendly, helpful AI assistant. Handle general conversation, simple questions, and greetings naturally.
Be concise and warm. Respond in the same language as the user.`,
    temperature: 0.7,
    maxTokens: 2048,
  });
}
