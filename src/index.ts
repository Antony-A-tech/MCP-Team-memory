#!/usr/bin/env node
/**
 * Team Memory MCP Server v2
 *
 * Supports two transport modes:
 * - stdio: for local Claude Code integration (default)
 * - http:  for remote server with Web UI (set MEMORY_TRANSPORT=http)
 */

import 'dotenv/config';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

if (config.transport === 'http') {
  // HTTP mode — import and run app.ts
  await import('./app.js');
} else {
  // stdio mode — original MCP server behavior
  const { PgStorage } = await import('./storage/pg-storage.js');
  const { MemoryManager } = await import('./memory/manager.js');
  const { TeamMemoryMCPServer } = await import('./server.js');

  logger.info({ transport: 'stdio', database: config.databaseUrl.replace(/\/\/.*:.*@/, '//***:***@') }, 'Team Memory MCP Server v2 starting');

  try {
    const storage = new PgStorage(config.databaseUrl, config.ftsLanguage);
    const { AuditLogger } = await import('./storage/audit.js');
    const auditLogger = new AuditLogger(storage.getPool());
    const { VersionManager } = await import('./storage/versioning.js');
    const versionManager = new VersionManager(storage.getPool());
    const memoryManager = new MemoryManager(storage, auditLogger, versionManager);
    await memoryManager.initialize();

    const mcpServer = new TeamMemoryMCPServer(memoryManager);
    await mcpServer.start();

    // Embedding provider (optional)
    if (config.embeddingProvider === 'gemini' && config.geminiApiKey) {
      const { GeminiEmbeddingProvider } = await import('./embedding/gemini.js');
      const embProvider = new GeminiEmbeddingProvider(config.geminiApiKey);
      await embProvider.initialize();
      if (embProvider.isReady()) {
        await memoryManager.setEmbeddingProvider(embProvider);
        memoryManager.backfillEmbeddings().catch(err => logger.error({ err }, 'Embedding backfill failed'));
      }
    } else if (config.embeddingProvider === 'ollama') {
      const { OllamaEmbeddingProvider } = await import('./embedding/ollama.js');
      const embProvider = new OllamaEmbeddingProvider(config.ollamaUrl, config.ollamaEmbeddingModel);
      await embProvider.initialize();
      if (embProvider.isReady()) {
        await memoryManager.setEmbeddingProvider(embProvider);
        memoryManager.backfillEmbeddings().catch(err => logger.error({ err }, 'Embedding backfill failed'));
      }
    } else if (config.embeddingProvider === 'local') {
      const { LocalEmbeddingProvider } = await import('./embedding/local.js');
      const embProvider = new LocalEmbeddingProvider(config.embeddingModelDir);
      await embProvider.initialize();
      if (embProvider.isReady()) {
        await memoryManager.setEmbeddingProvider(embProvider);
        memoryManager.backfillEmbeddings().catch(err => logger.error({ err }, 'Embedding backfill failed'));
      }
    }

    // Qdrant vector store (optional)
    if (config.vectorStore === 'qdrant') {
      try {
        const { QdrantVectorStore } = await import('./vector/qdrant-store.js');
        const vectorStore = new QdrantVectorStore(config.qdrantUrl, config.qdrantApiKey);
        const dims = memoryManager.getEmbeddingProvider()?.dimensions ?? 768;
        await vectorStore.ensureCollection('entries', dims);
        await vectorStore.createPayloadIndex('entries', 'project_id', 'keyword');
        await vectorStore.createPayloadIndex('entries', 'category', 'keyword');
        await vectorStore.createPayloadIndex('entries', 'status', 'keyword');
        await vectorStore.createPayloadIndex('entries', 'author', 'keyword');
        memoryManager.setVectorStore(vectorStore);
        logger.info({ url: config.qdrantUrl }, 'Qdrant vector store connected');
      } catch (err) {
        logger.warn({ err }, 'Failed to connect to Qdrant — vector search will use pgvector fallback');
      }
    }

    if (config.autoArchiveEnabled) {
      const decayConfig = config.decayThreshold !== undefined
        ? { threshold: config.decayThreshold, decayDays: config.decayDays, weights: config.decayWeights }
        : undefined;
      memoryManager.startAutoArchive(config.autoArchiveDays, undefined, decayConfig);
      logger.info({ days: config.autoArchiveDays, decay: !!decayConfig }, 'Auto-archive enabled');
    }

    logger.info('MCP Server ready. Waiting for commands...');

    let isShuttingDown = false;
    const shutdownStdio = async (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info({ signal }, 'Shutting down stdio server');
      await memoryManager.close();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdownStdio('SIGINT'));
    process.on('SIGTERM', () => shutdownStdio('SIGTERM'));
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}
