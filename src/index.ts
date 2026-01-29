#!/usr/bin/env node
/**
 * Team Memory MCP Server
 *
 * This runs as MCP server through stdio protocol.
 * For Web UI, run standalone-web.ts separately.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { TeamMemoryMCPServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration from environment variables
const config = {
  dataPath: process.env.MEMORY_DATA_PATH || path.join(__dirname, '..', 'data'),
  autoArchiveEnabled: process.env.MEMORY_AUTO_ARCHIVE !== 'false',
  autoArchiveDays: parseInt(process.env.MEMORY_AUTO_ARCHIVE_DAYS || '14', 10),
};

async function main(): Promise<void> {
  // Use stderr for logs (stdout is reserved for MCP JSON-RPC)
  console.error('='.repeat(50));
  console.error('Team Memory MCP Server (stdio mode)');
  console.error('='.repeat(50));
  console.error(`Data path: ${config.dataPath}`);
  console.error('='.repeat(50));

  try {
    // Initialize MCP Server only
    const mcpServer = new TeamMemoryMCPServer(config.dataPath);
    await mcpServer.start();

    // Start auto-archive for old entries (non-pinned, older than N days)
    if (config.autoArchiveEnabled) {
      const memoryManager = mcpServer.getMemoryManager();
      memoryManager.startAutoArchive(config.autoArchiveDays);
      console.error(`Auto-archive enabled: entries older than ${config.autoArchiveDays} days will be archived (pinned entries excluded)`);
    }

    console.error('MCP Server ready. Waiting for commands...');

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
