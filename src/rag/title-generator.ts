import type { ChatLlmProvider } from '../llm/chat-provider.js';
import type { ChatManager } from '../chat/manager.js';
import logger from '../logger.js';

const MAX_INPUT_CHARS = 500;

export class TitleGenerator {
  constructor(private provider: ChatLlmProvider, private chatManager: ChatManager) {}

  async generate(sessionId: string, firstUser: string, firstAssistant: string): Promise<void> {
    const user = firstUser.slice(0, MAX_INPUT_CHARS);
    const assistant = firstAssistant.slice(0, MAX_INPUT_CHARS);
    const prompt = `Придумай заголовок 3-6 слов на языке сообщения, без кавычек.
User: ${user}
Assistant: ${assistant}

Title:`;

    try {
      const raw = await this.provider.generate({ prompt, maxTokens: 20, temperature: 0.3 });
      const cleaned = raw.replace(/^["'«»]+|["'«»]+$/g, '').trim().slice(0, 120);
      if (cleaned.length === 0) return;
      await this.chatManager.updateAutoTitle(sessionId, cleaned);
    } catch (err: any) {
      logger.warn({ sessionId, err: err?.message }, 'Title generation failed; leaving default title');
    }
  }
}
