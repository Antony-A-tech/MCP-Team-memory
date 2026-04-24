import type { ToolDeclaration } from '../llm/chat-provider.js';
import { TOOL_DECLARATIONS, TOOL_HANDLERS, type ToolHandlerContext } from './tool-registry.js';
import logger from '../logger.js';

export class ToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolAdapterOptions {
  agentTokenId: string;
  projectId: string;
  toolResponseMaxChars: number;
}

export class McpToolAdapter {
  readonly declarations: ToolDeclaration[] = TOOL_DECLARATIONS;

  constructor(
    private managers: Omit<ToolHandlerContext, 'agentTokenId' | 'projectId'>,
    private options: ToolAdapterOptions,
  ) {}

  async call(name: string, llmArgs: Record<string, unknown>): Promise<unknown> {
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      throw new ToolError('unknown_tool', `unknown_tool: ${name}`);
    }
    const ctx: ToolHandlerContext = {
      ...this.managers,
      agentTokenId: this.options.agentTokenId,
      projectId: this.options.projectId,
    };
    const start = Date.now();
    try {
      const result = await handler(llmArgs, ctx);
      logger.info({
        tool: name,
        durationMs: Date.now() - start,
        ok: true,
      }, 'Tool call succeeded');
      return result;
    } catch (err: any) {
      logger.error({ tool: name, err: err?.message }, 'Tool call failed');
      throw new ToolError('tool_failure', err?.message ?? 'Tool execution error');
    }
  }

  async callAsSerializedString(name: string, llmArgs: Record<string, unknown>): Promise<string> {
    const result = await this.call(name, llmArgs);
    const serialized = JSON.stringify(result);
    const max = this.options.toolResponseMaxChars;
    if (serialized.length <= max) return serialized;
    return serialized.slice(0, max) + '...[truncated]';
  }
}
