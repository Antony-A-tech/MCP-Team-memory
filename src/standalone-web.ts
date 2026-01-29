#!/usr/bin/env node
/**
 * Standalone Web UI server for team-memory
 * Run this separately from MCP to provide Web UI for the team
 * MCP will work through stdio, this provides Web dashboard
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { MemoryManager } from './memory/manager.js';
import { SyncWebSocketServer } from './sync/websocket.js';
import { WebServer } from './web/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  dataPath: process.env.MEMORY_DATA_PATH || path.join(__dirname, '..', 'data'),
  webPort: parseInt(process.env.MEMORY_WEB_PORT || '3846', 10),
  wsPort: parseInt(process.env.MEMORY_WS_PORT || '3847', 10),
  enableAutoBackup: process.env.MEMORY_AUTO_BACKUP !== 'false',
  backupIntervalMs: parseInt(process.env.MEMORY_BACKUP_INTERVAL || '3600000', 10)
};

async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('Team Memory - Standalone Web UI Server');
  console.log('='.repeat(50));
  console.log(`Data path: ${config.dataPath}`);
  console.log(`Web UI port: ${config.webPort}`);
  console.log(`WebSocket port: ${config.wsPort}`);
  console.log('='.repeat(50));

  try {
    // Initialize Memory Manager (shared data with MCP)
    const memoryManager = new MemoryManager(config.dataPath);
    await memoryManager.initialize();

    // Initialize WebSocket server
    const wsServer = new SyncWebSocketServer(memoryManager);
    wsServer.start(config.wsPort);

    // Initialize Web UI server
    const webServer = new WebServer(memoryManager, wsServer);
    webServer.start(config.webPort);

    // Enable auto backup
    if (config.enableAutoBackup) {
      memoryManager.startAutoBackup(config.backupIntervalMs);
      console.log(`Auto backup enabled: every ${config.backupIntervalMs / 1000}s`);
    }

    console.log('\nStandalone Web UI is running.');
    console.log(`Open http://localhost:${config.webPort} in your browser.`);
    console.log('Press Ctrl+C to stop.\n');

    // Handle shutdown
    const shutdown = (): void => {
      console.log('\nShutting down...');
      wsServer.stop();
      memoryManager.stopAutoBackup();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
