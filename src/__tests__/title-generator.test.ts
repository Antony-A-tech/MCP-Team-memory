import { describe, it, expect, vi } from 'vitest';
import { TitleGenerator } from '../rag/title-generator.js';

describe('TitleGenerator', () => {
  it('calls provider.generate with truncated prompt and updates title', async () => {
    const provider = {
      generate: vi.fn().mockResolvedValue('Обсуждение фичи X'),
      isReady: () => true,
    } as any;
    const chatManager = { updateAutoTitle: vi.fn() } as any;
    const gen = new TitleGenerator(provider, chatManager);

    await gen.generate('sess-1', 'как работает фича X?', 'Вот как работает фича X…');

    expect(provider.generate).toHaveBeenCalled();
    const promptArg = provider.generate.mock.calls[0][0].prompt;
    expect(promptArg).toContain('User: как работает фича X?');
    expect(promptArg).toContain('Assistant: Вот как работает');
    expect(chatManager.updateAutoTitle).toHaveBeenCalledWith('sess-1', 'Обсуждение фичи X');
  });

  it('strips quotes from generated title', async () => {
    const provider = { generate: vi.fn().mockResolvedValue('"Quoted title"'), isReady: () => true } as any;
    const chatManager = { updateAutoTitle: vi.fn() } as any;
    const gen = new TitleGenerator(provider, chatManager);
    await gen.generate('sess-1', 'q', 'a');
    expect(chatManager.updateAutoTitle).toHaveBeenCalledWith('sess-1', 'Quoted title');
  });

  it('swallows errors silently (logs only)', async () => {
    const provider = { generate: vi.fn().mockRejectedValue(new Error('rate_limited')), isReady: () => true } as any;
    const chatManager = { updateAutoTitle: vi.fn() } as any;
    const gen = new TitleGenerator(provider, chatManager);
    await expect(gen.generate('sess-1', 'q', 'a')).resolves.toBeUndefined();
    expect(chatManager.updateAutoTitle).not.toHaveBeenCalled();
  });
});
